#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/dqblk_xfs.h>
#include <linux/fs.h>
#include <linux/magic.h>
#include <linux/openat2.h>
#include <linux/stat.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

/*
 * Kogg's qualified Linux allocation owner. Input and output are bounded closed
 * JSON records on stdin/stdout; the already-open state-root descriptor is fd 3.
 * No path supplied by a caller is accepted or constructed.
 * diagnostic-coverage: execution.worktree-registry, execution.capacity, execution.recovery, execution.process-cleanup
 */
#define ROOT_FD 3
#define KOGG_MAX_INPUT 4096
#define MAX_PAIRS 20
#define MAX_KEY 40
#define MAX_VALUE 192
#define RESOLVE_POLICY (RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)

struct pair { char key[MAX_KEY]; char value[MAX_VALUE]; bool number; };
struct object { struct pair pairs[MAX_PAIRS]; size_t count; };

static void fail(const char *code) {
  dprintf(STDOUT_FILENO, "{\"schemaVersion\":1,\"ok\":false,\"safeCode\":\"%s\"}\n", code);
  _exit(1);
}

static bool safe_char(unsigned char value) { return value >= 0x20 && value <= 0x7e && value != '"' && value != '\\'; }

static bool json_string(const char **cursor, char *output, size_t capacity) {
  const char *at = *cursor; size_t used = 0;
  if (*at++ != '"') return false;
  while (*at && *at != '"') {
    if (!safe_char((unsigned char)*at) || used + 1 >= capacity) return false;
    output[used++] = *at++;
  }
  if (*at++ != '"') return false;
  output[used] = '\0'; *cursor = at; return true;
}

static bool parse_object(const char *input, struct object *result) {
  const char *at = input;
  if (*at++ != '{') return false;
  while (*at != '}') {
    if (result->count >= MAX_PAIRS) return false;
    struct pair *pair = &result->pairs[result->count];
    if (!json_string(&at, pair->key, sizeof(pair->key)) || *at++ != ':') return false;
    for (size_t index = 0; index < result->count; index++) if (strcmp(result->pairs[index].key, pair->key) == 0) return false;
    if (*at == '"') {
      pair->number = false;
      if (!json_string(&at, pair->value, sizeof(pair->value))) return false;
    } else {
      pair->number = true; size_t used = 0;
      while (*at >= '0' && *at <= '9') {
        if (used + 1 >= sizeof(pair->value)) return false;
        pair->value[used++] = *at++;
      }
      if (used == 0) return false;
      pair->value[used] = '\0';
    }
    result->count++;
    if (*at == ',') at++;
    else if (*at != '}') return false;
  }
  return at[1] == '\0';
}

static const struct pair *field(const struct object *object, const char *key) {
  for (size_t index = 0; index < object->count; index++) if (strcmp(object->pairs[index].key, key) == 0) return &object->pairs[index];
  return NULL;
}

static bool exact_fields(const struct object *object, const char *const *keys, size_t count) {
  if (object->count != count) return false;
  for (size_t index = 0; index < count; index++) if (field(object, keys[index]) == NULL) return false;
  return true;
}

static bool fixed(const char *value, size_t length, bool (*predicate)(char)) {
  if (strlen(value) != length) return false;
  for (size_t index = 0; index < length; index++) if (!predicate(value[index])) return false;
  return true;
}
static bool lower_hex(char value) { return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'); }
static bool decimal_char(char value) { return value >= '0' && value <= '9'; }
static bool base32_char(char value) { return (value >= 'a' && value <= 'z') || (value >= '2' && value <= '7'); }

static bool uuid4(const char *value) {
  if (strlen(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' || value[14] != '4'
      || !strchr("89ab", value[19])) return false;
  for (size_t index = 0; index < 36; index++) if (index != 8 && index != 13 && index != 18 && index != 23 && !lower_hex(value[index])) return false;
  return true;
}

static bool allocation_name(const char *value) { return strlen(value) == 28 && value[0] == 'r' && value[1] == '-' && fixed(value + 2, 26, base32_char); }

static bool timestamp(const char *value) {
  if (strlen(value) != 24 || value[4] != '-' || value[7] != '-' || value[10] != 'T' || value[13] != ':' || value[16] != ':' || value[19] != '.' || value[23] != 'Z') return false;
  for (size_t index = 0; index < 24; index++) {
    if (index == 4 || index == 7 || index == 10 || index == 13 || index == 16 || index == 19 || index == 23) continue;
    if (!decimal_char(value[index])) return false;
  }
  return true;
}

static bool decimal_u64(const char *value, uint64_t *result, bool allow_zero) {
  if (!*value || (value[0] == '0' && value[1] != '\0')) return false;
  errno = 0; char *end = NULL; unsigned long long parsed = strtoull(value, &end, 10);
  if (errno || *end || (!allow_zero && parsed == 0)) return false;
  *result = (uint64_t)parsed; return true;
}

static int open_beneath(int directory, const char *name, int flags) {
  struct open_how how = { .flags = (uint64_t)flags, .mode = 0, .resolve = RESOLVE_POLICY };
  return (int)syscall(SYS_openat2, directory, name, &how, sizeof(how));
}

static bool root_qualified(struct stat *root) {
  struct statfs filesystem;
  if (fstat(ROOT_FD, root) || fstatfs(ROOT_FD, &filesystem)) return false;
  return S_ISDIR(root->st_mode) && (root->st_mode & 0777) == 0700 && root->st_uid == geteuid() && filesystem.f_type == XFS_SUPER_MAGIC;
}

static bool identity(int fd, const struct stat *root, struct stat *stat, uint64_t *mount_id, uint32_t *project_id) {
  struct statx extended; struct fsxattr attributes;
  memset(&extended, 0, sizeof(extended)); memset(&attributes, 0, sizeof(attributes));
  if (fstat(fd, stat) || syscall(SYS_statx, fd, "", AT_EMPTY_PATH | AT_STATX_SYNC_AS_STAT, STATX_MNT_ID, &extended)
      || ioctl(fd, FS_IOC_FSGETXATTR, &attributes)) return false;
  if (!S_ISDIR(stat->st_mode) || (stat->st_mode & 0777) != 0700 || stat->st_uid != geteuid() || stat->st_dev != root->st_dev) return false;
  *mount_id = extended.stx_mnt_id; *project_id = attributes.fsx_projid; return true;
}

static bool set_project(int fd, uint32_t project_id) {
  struct fsxattr attributes;
  memset(&attributes, 0, sizeof(attributes));
  if (ioctl(fd, FS_IOC_FSGETXATTR, &attributes)) return false;
  attributes.fsx_projid = project_id; attributes.fsx_xflags |= FS_XFLAG_PROJINHERIT;
  return ioctl(fd, FS_IOC_FSSETXATTR, &attributes) == 0;
}

static bool set_quota(uint32_t project_id, uint64_t bytes, uint64_t inodes) {
  fs_disk_quota_t quota;
  memset(&quota, 0, sizeof(quota));
  quota.d_version = FS_DQUOT_VERSION; quota.d_flags = FS_PROJ_QUOTA; quota.d_id = project_id;
  quota.d_fieldmask = FS_DQ_BHARD | FS_DQ_BSOFT | FS_DQ_IHARD | FS_DQ_ISOFT;
  quota.d_blk_hardlimit = quota.d_blk_softlimit = (bytes + 511u) / 512u;
  quota.d_ino_hardlimit = quota.d_ino_softlimit = inodes;
  return syscall(SYS_quotactl_fd, ROOT_FD, Q_XSETQLIM, project_id, &quota) == 0;
}

static bool read_quota(uint32_t project_id, fs_disk_quota_t *quota) {
  memset(quota, 0, sizeof(*quota));
  quota->d_version = FS_DQUOT_VERSION;
  quota->d_flags = FS_PROJ_QUOTA;
  quota->d_id = project_id;
  return syscall(SYS_quotactl_fd, ROOT_FD, Q_XGETQUOTA, project_id, quota) == 0;
}

static bool quota_unused(uint32_t project_id) {
  fs_disk_quota_t quota;
  return read_quota(project_id, &quota)
    && quota.d_bcount == 0 && quota.d_icount == 0
    && quota.d_blk_hardlimit == 0 && quota.d_blk_softlimit == 0
    && quota.d_ino_hardlimit == 0 && quota.d_ino_softlimit == 0;
}

static bool quota_matches(uint32_t project_id, uint64_t bytes, uint64_t inodes) {
  fs_disk_quota_t quota;
  uint64_t blocks = (bytes + 511u) / 512u;
  return read_quota(project_id, &quota)
    && quota.d_blk_hardlimit == blocks && quota.d_blk_softlimit == blocks
    && quota.d_ino_hardlimit == inodes && quota.d_ino_softlimit == inodes;
}

static void qualify(const struct object *request) {
  const char *const keys[] = {"schemaVersion", "operation"};
  if (!exact_fields(request, keys, 2) || !field(request, "schemaVersion")->number
      || strcmp(field(request, "schemaVersion")->value, "1")
      || field(request, "operation")->number || strcmp(field(request, "operation")->value, "qualify"))
    fail("ALLOCATION_PROTOCOL_INVALID");
  struct stat root, identity;
  struct statx extended;
  struct fsxattr attributes;
  fs_disk_quota_t quota;
  const uint32_t probe_project = UINT32_MAX - 1u;
  memset(&extended, 0, sizeof(extended)); memset(&attributes, 0, sizeof(attributes)); memset(&quota, 0, sizeof(quota));
  quota.d_version = FS_DQUOT_VERSION; quota.d_flags = FS_PROJ_QUOTA; quota.d_id = probe_project;
  if (!root_qualified(&root) || fstat(ROOT_FD, &identity)
      || syscall(SYS_statx, ROOT_FD, "", AT_EMPTY_PATH | AT_STATX_SYNC_AS_STAT, STATX_MNT_ID, &extended)
      || ioctl(ROOT_FD, FS_IOC_FSGETXATTR, &attributes)
      || syscall(SYS_quotactl_fd, ROOT_FD, Q_XGETQUOTA, probe_project, &quota)
      || quota.d_bcount != 0 || quota.d_icount != 0
      || quota.d_blk_hardlimit != 0 || quota.d_ino_hardlimit != 0)
    fail("ALLOCATION_QUALIFICATION_INVALID");
  dprintf(STDOUT_FILENO, "{\"schemaVersion\":1,\"ok\":true,\"safeCode\":\"ALLOCATION_OK\",\"filesystemDevice\":\"%ju\",\"filesystemInode\":\"%ju\",\"ownerUid\":\"%ju\",\"mode\":\"0700\",\"mountId\":\"%" PRIu64 "\",\"rootProjectId\":\"%u\",\"quotaProbeProjectId\":\"%u\"}\n",
    (uintmax_t)identity.st_dev, (uintmax_t)identity.st_ino, (uintmax_t)identity.st_uid,
    extended.stx_mnt_id, attributes.fsx_projid, probe_project);
}

static bool write_all(int fd, const char *value, size_t length) {
  size_t written = 0;
  while (written < length) {
    ssize_t count = write(fd, value + written, length - written);
    if (count <= 0) return false;
    written += (size_t)count;
  }
  return true;
}

static bool write_metadata(int directory, const struct object *request) {
  const char *worktree = field(request, "worktreeId")->value;
  const char *nonce = field(request, "allocationNonce")->value;
  const char *owner = field(request, "ownerInstanceId")->value;
  const char *created = field(request, "createdAt")->value;
  char content[640];
  int length = snprintf(content, sizeof(content), "{\"schemaVersion\":1,\"worktreeId\":\"%s\",\"allocationNonce\":\"%s\",\"ownerInstanceId\":\"%s\",\"createdAt\":\"%s\"}\n", worktree, nonce, owner, created);
  if (length <= 0 || (size_t)length >= sizeof(content)) return false;
  int metadata = openat(directory, "allocation.json", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (metadata < 0) return false;
  bool okay = write_all(metadata, content, (size_t)length) && fsync(metadata) == 0;
  if (close(metadata)) okay = false;
  return okay && fsync(directory) == 0;
}

static bool metadata_matches(int directory, const struct object *request) {
  int metadata = open_beneath(directory, "allocation.json", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (metadata < 0) return false;
  char input[768]; ssize_t count = read(metadata, input, sizeof(input) - 1); bool okay = count > 0 && count < (ssize_t)(sizeof(input) - 1);
  if (okay) { input[count] = '\0'; if (input[count - 1] == '\n') input[count - 1] = '\0'; }
  if (close(metadata)) okay = false;
  struct object stored = {0};
  const char *const keys[] = {"schemaVersion", "worktreeId", "allocationNonce", "ownerInstanceId", "createdAt"};
  return okay && parse_object(input, &stored) && exact_fields(&stored, keys, 5)
    && field(&stored, "schemaVersion")->number && strcmp(field(&stored, "schemaVersion")->value, "1") == 0
    && strcmp(field(&stored, "worktreeId")->value, field(request, "worktreeId")->value) == 0
    && strcmp(field(&stored, "allocationNonce")->value, field(request, "allocationNonce")->value) == 0
    && strcmp(field(&stored, "ownerInstanceId")->value, field(request, "ownerInstanceId")->value) == 0
    && strcmp(field(&stored, "createdAt")->value, field(request, "createdAt")->value) == 0;
}

static void allocate(const struct object *request) {
  const char *const keys[] = {"schemaVersion", "operation", "allocationName", "allocationNonce", "worktreeId", "ownerInstanceId", "createdAt", "quotaProjectId", "quotaBytes", "quotaInodes"};
  uint64_t project = 0, bytes = 0, inodes = 0;
  if (!exact_fields(request, keys, 10) || !field(request, "schemaVersion")->number || strcmp(field(request, "schemaVersion")->value, "1")
      || field(request, "operation")->number || field(request, "allocationName")->number || field(request, "allocationNonce")->number
      || field(request, "worktreeId")->number || field(request, "ownerInstanceId")->number || field(request, "createdAt")->number
      || field(request, "quotaProjectId")->number || field(request, "quotaBytes")->number || field(request, "quotaInodes")->number
      || strcmp(field(request, "operation")->value, "allocate") || !allocation_name(field(request, "allocationName")->value)
      || !fixed(field(request, "allocationNonce")->value, 64, lower_hex) || !uuid4(field(request, "worktreeId")->value)
      || !uuid4(field(request, "ownerInstanceId")->value) || !timestamp(field(request, "createdAt")->value)
      || !decimal_u64(field(request, "quotaProjectId")->value, &project, false) || project > UINT32_MAX
      || !decimal_u64(field(request, "quotaBytes")->value, &bytes, false) || !decimal_u64(field(request, "quotaInodes")->value, &inodes, false)) fail("ALLOCATION_PROTOCOL_INVALID");
  struct stat root;
  if (!root_qualified(&root)) fail("ALLOCATION_QUALIFICATION_INVALID");
  const char *name = field(request, "allocationName")->value;
  int existing = open_beneath(ROOT_FD, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (existing >= 0) { close(existing); fail("ALLOCATION_STATE_INVALID"); }
  if (errno != ENOENT) fail("ALLOCATION_INTEGRITY_FAILED");
  if (!quota_unused((uint32_t)project)) fail("ALLOCATION_STATE_INVALID");
  if (mkdirat(ROOT_FD, name, 0700)) fail("ALLOCATION_INTEGRITY_FAILED");
  int directory = open_beneath(ROOT_FD, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (directory < 0) fail("ALLOCATION_INTEGRITY_FAILED");
  struct stat stat; uint64_t mount_id; uint32_t observed_project;
  if (!identity(directory, &root, &stat, &mount_id, &observed_project) || !set_project(directory, (uint32_t)project)
      || !set_quota((uint32_t)project, bytes, inodes) || !quota_matches((uint32_t)project, bytes, inodes) || !write_metadata(directory, request)
      || !identity(directory, &root, &stat, &mount_id, &observed_project) || observed_project != (uint32_t)project
      || fsync(ROOT_FD)) { close(directory); fail("ALLOCATION_INTEGRITY_FAILED"); }
  if (close(directory)) fail("ALLOCATION_INTEGRITY_FAILED");
  dprintf(STDOUT_FILENO, "{\"schemaVersion\":1,\"ok\":true,\"safeCode\":\"ALLOCATION_OK\",\"filesystemDevice\":\"%ju\",\"filesystemInode\":\"%ju\",\"ownerUid\":\"%ju\",\"mode\":\"0700\",\"mountId\":\"%" PRIu64 "\",\"quotaProjectId\":\"%" PRIu64 "\"}\n",
    (uintmax_t)stat.st_dev, (uintmax_t)stat.st_ino, (uintmax_t)stat.st_uid, mount_id, project);
}

static bool remove_contents(int directory) {
  int duplicate = dup(directory);
  if (duplicate < 0) return false;
  DIR *stream = fdopendir(duplicate);
  if (!stream) { close(duplicate); return false; }
  bool okay = true; struct dirent *entry;
  for (;;) {
    errno = 0;
    entry = readdir(stream);
    if (!entry) { if (errno) okay = false; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    struct stat stat;
    if (fstatat(directory, entry->d_name, &stat, AT_SYMLINK_NOFOLLOW)) { okay = false; break; }
    if (S_ISDIR(stat.st_mode)) {
      int child = open_beneath(directory, entry->d_name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      if (child < 0 || !remove_contents(child) || close(child) || unlinkat(directory, entry->d_name, AT_REMOVEDIR)) { okay = false; break; }
    } else if (unlinkat(directory, entry->d_name, 0)) { okay = false; break; }
  }
  if (closedir(stream)) okay = false;
  return okay && fsync(directory) == 0;
}

static void cleanup(const struct object *request) {
  const char *const keys[] = {"schemaVersion", "operation", "allocationName", "allocationNonce", "worktreeId", "ownerInstanceId", "createdAt", "filesystemDevice", "filesystemInode", "ownerUid", "mode", "mountId", "quotaProjectId"};
  uint64_t expected_device = 0, expected_inode = 0, expected_uid = 0, expected_mount = 0, expected_project = 0;
  if (!exact_fields(request, keys, 13) || !field(request, "schemaVersion")->number || strcmp(field(request, "schemaVersion")->value, "1")
      || field(request, "operation")->number || field(request, "allocationName")->number || field(request, "allocationNonce")->number
      || field(request, "worktreeId")->number || field(request, "ownerInstanceId")->number || field(request, "createdAt")->number
      || field(request, "filesystemDevice")->number || field(request, "filesystemInode")->number || field(request, "ownerUid")->number
      || field(request, "mode")->number || field(request, "mountId")->number || field(request, "quotaProjectId")->number
      || strcmp(field(request, "operation")->value, "cleanup") || !allocation_name(field(request, "allocationName")->value)
      || !fixed(field(request, "allocationNonce")->value, 64, lower_hex) || !uuid4(field(request, "worktreeId")->value)
      || !uuid4(field(request, "ownerInstanceId")->value) || !timestamp(field(request, "createdAt")->value) || strcmp(field(request, "mode")->value, "0700")
      || !decimal_u64(field(request, "filesystemDevice")->value, &expected_device, true)
      || !decimal_u64(field(request, "filesystemInode")->value, &expected_inode, false)
      || !decimal_u64(field(request, "ownerUid")->value, &expected_uid, true)
      || !decimal_u64(field(request, "mountId")->value, &expected_mount, false)
      || !decimal_u64(field(request, "quotaProjectId")->value, &expected_project, false) || expected_project > UINT32_MAX) fail("ALLOCATION_PROTOCOL_INVALID");
  struct stat root;
  if (!root_qualified(&root)) fail("ALLOCATION_QUALIFICATION_INVALID");
  const char *name = field(request, "allocationName")->value;
  int directory = open_beneath(ROOT_FD, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (directory < 0) fail("CLEANUP_IDENTITY_MISMATCH");
  struct stat stat; uint64_t mount_id; uint32_t project_id;
  if (!identity(directory, &root, &stat, &mount_id, &project_id)
      || (uint64_t)stat.st_dev != expected_device || (uint64_t)stat.st_ino != expected_inode || (uint64_t)stat.st_uid != expected_uid
      || mount_id != expected_mount || project_id != (uint32_t)expected_project || !metadata_matches(directory, request)) {
    close(directory); fail("CLEANUP_IDENTITY_MISMATCH");
  }
  if (!remove_contents(directory) || close(directory) || unlinkat(ROOT_FD, name, AT_REMOVEDIR) || fsync(ROOT_FD)
      || !set_quota((uint32_t)expected_project, 0, 0) || !quota_unused((uint32_t)expected_project)) fail("CLEANUP_FAILED");
  int absent = open_beneath(ROOT_FD, name, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (absent >= 0) { close(absent); fail("CLEANUP_FAILED"); }
  if (errno != ENOENT) fail("CLEANUP_FAILED");
  dprintf(STDOUT_FILENO, "{\"schemaVersion\":1,\"ok\":true,\"safeCode\":\"ALLOCATION_OK\",\"absent\":true,\"quotaProjectId\":\"%" PRIu64 "\"}\n", expected_project);
}

int main(void) {
  char input[KOGG_MAX_INPUT + 1]; size_t used = 0;
  while (used < KOGG_MAX_INPUT) {
    ssize_t count = read(STDIN_FILENO, input + used, KOGG_MAX_INPUT - used);
    if (count < 0) fail("ALLOCATION_PROTOCOL_INVALID");
    if (count == 0) break;
    used += (size_t)count;
  }
  if (used == 0 || used == KOGG_MAX_INPUT) fail("ALLOCATION_PROTOCOL_INVALID");
  input[used] = '\0';
  if (input[used - 1] == '\n') input[--used] = '\0';
  struct object request = {0};
  if (!parse_object(input, &request)) fail("ALLOCATION_PROTOCOL_INVALID");
  const struct pair *operation = field(&request, "operation");
  if (!operation || operation->number) fail("ALLOCATION_PROTOCOL_INVALID");
  if (!strcmp(operation->value, "qualify")) qualify(&request);
  else if (!strcmp(operation->value, "allocate")) allocate(&request);
  else if (!strcmp(operation->value, "cleanup")) cleanup(&request);
  else fail("ALLOCATION_PROTOCOL_INVALID");
  return 0;
}
