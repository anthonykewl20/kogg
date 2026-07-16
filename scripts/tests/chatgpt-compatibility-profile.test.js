/**
 * @license
 * Copyright 2026 Kogg Authors
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { format } from 'prettier';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROFILE_PATH = resolve(
  ROOT,
  'docs/design/chatgpt-codex-compatibility-profile.v1.json',
);
const EVIDENCE_PATH = resolve(
  ROOT,
  'docs/design/2026-07-16-codex-compatibility-profile-evidence.md',
);
const SOURCE_SHA = 'cbc83d961e8132bfff4d340ab8342d181b79e95e';
const DISPOSITION = 'UNRESOLVED — fail closed';

const TOP_LEVEL_KEYS = [
  'capabilities',
  'contextBudget',
  'contractSemantics',
  'contracts',
  'observedSource',
  'productionEnabled',
  'profileId',
  'publicTestVectors',
  'releaseIdentity',
  'resourceProfiles',
  'schemaVersion',
  'state',
  'transportPolicy',
  'unknownResponsePolicy',
  'unresolvedContracts',
];

const RESOURCE_KEYS = [
  'maxHeaderBytes',
  'maxHeaderCount',
  'maxHeaderValueBytes',
  'maxBodyBytes',
  'maxStringBytes',
  'maxArrayElements',
  'maxObjectFields',
  'maxJsonDepth',
  'maxSseEventBytes',
  'maxSseEvents',
  'maxIdleMs',
  'maxTotalMs',
];

const RESOURCE_PROFILES = {
  oauth_callback: [16384, 32, 8192, 0, 8192, 0, 8, 1, 0, 0, 5000, 5000],
  oauth_unary: [
    32768, 64, 16384, 131072, 32768, 256, 128, 16, 0, 0, 10000, 30000,
  ],
  identity: [
    32768, 64, 16384, 1048576, 65536, 4096, 512, 32, 0, 0, 10000, 30000,
  ],
  models: [32768, 64, 16384, 8388608, 65536, 4096, 512, 32, 0, 0, 10000, 30000],
  limits: [32768, 64, 16384, 4194304, 65536, 4096, 512, 32, 0, 0, 10000, 30000],
  responses_sse: [
    32768, 64, 16384, 67108864, 4194304, 16384, 4096, 64, 4194304, 65536, 45000,
    1200000,
  ],
  native_compaction: [
    32768, 64, 16384, 33554432, 4194304, 16384, 4096, 64, 0, 0, 30000, 120000,
  ],
};

const CONTRACT_IDS = [
  'auth.browser.authorize',
  'auth.browser.callback',
  'auth.browser.token_exchange',
  'auth.api_key_token_exchange',
  'auth.device.user_code',
  'auth.device.poll',
  'auth.device.token_exchange',
  'auth.refresh',
  'auth.revoke',
  'identity.jwt_claims',
  'limits.token_usage_profile',
  'entitlement.account_check',
  'models.catalog',
  'limits.usage',
  'responses.sse',
  'compaction.v1',
  'compaction.v2',
];

const GAP_IDS = [
  'ACTIONABILITY_CLASSIFICATION',
  'AFFIRMATIVE_ENTITLEMENT',
  'AUTH_CLIENT_REGISTRATION',
  'COMPACTION_PROTOCOL',
  'CONTEXT_ACCOUNTING',
  'DEVICE_TERMINAL_SEMANTICS',
  'LIMITS_SCHEMA',
  'MODELS_SCHEMA',
  'PRIVATE_ENDPOINT_AUTHORIZATION',
  'RELEASE_TRUST',
  'RESOURCE_CEILINGS',
  'RESPONSES_PROTOCOL',
  'SECURE_STORAGE',
  'TOKEN_VALIDATION',
];

const REQUEST_KEYS = [
  'additionalFields',
  'authority',
  'body',
  'contentType',
  'headers',
  'method',
  'path',
  'query',
];

const MATCHER_KEYS = ['fixed', 'nondeterministic', 'optional', 'required'];

const CONTRACT_BASE_KEYS = [
  'ownership',
  'observationKind',
  'productionStatus',
  'blockingGaps',
  'sources',
  'request',
  'response',
  'resourceProfile',
  'cancellation',
  'drift',
];

const CONTRACT_EXTRA_KEYS = {
  'auth.browser.authorize': [
    'authorizedKoggClient',
    'observedFirstPartyClientId',
    'observedFirstPartyIdentityMayBeUsedByKogg',
  ],
  'auth.browser.callback': [
    'observedBindHost',
    'observedPreferredPorts',
    'observedFollowupPaths',
    'requestSemantics',
    'normativePolicy',
  ],
  'auth.device.user_code': [
    'verificationPath',
    'responseAliases',
    'responseSemantics',
  ],
  'auth.device.poll': ['overallLifetimeMs'],
  'auth.refresh': ['normativePolicy'],
  'auth.revoke': ['normativePolicy'],
  'limits.token_usage_profile': ['responseSchema'],
  'entitlement.account_check': [
    'observedPurpose',
    'entitlementInterpretation',
    'responseSchema',
  ],
  'models.catalog': ['modelFields'],
  'responses.sse': ['eventProtocol'],
  'compaction.v1': ['responseItemTypes', 'observedUnknownItemBehavior'],
  'auth.api_key_token_exchange': [
    'observedFirstPartyBehavior',
    'koggSendPolicy',
    'paidApiFallback',
  ],
};

const RESPONSE_STATUS_EXTRA_KEYS = {
  'auth.browser.authorize': ['observed'],
  'auth.device.poll': ['observedPendingIndistinguishable'],
  'responses.sse': ['terminalEvent'],
  'compaction.v2': ['terminalEvent'],
};

function expectExactKeys(value, keys) {
  expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

function sha256Domain(domain, canonicalJson) {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update(Buffer.from([0]))
    .update(canonicalJson, 'utf8')
    .digest('hex');
}

describe('ChatGPT Codex compatibility profile', () => {
  const profileJson = readFileSync(PROFILE_PATH, 'utf8');
  const profile = JSON.parse(profileJson);
  const evidence = readFileSync(EVIDENCE_PATH, 'utf8');

  it('is duplicate-free formatted JSON', async () => {
    expect(await format(JSON.stringify(profile), { parser: 'json' })).toBe(
      profileJson,
    );
  });

  it('is a closed, blocked machine contract with no circular digest', () => {
    expect(Object.keys(profile).sort()).toEqual(TOP_LEVEL_KEYS);
    expect(profile.schemaVersion).toBe(1);
    expect(profile.profileId).toBe('kogg-chatgpt-codex-compatibility-v1');
    expect(profile.state).toBe('blocked');
    expect(profile.productionEnabled).toBe(false);
    expect(profile).not.toHaveProperty('profileDigest');
    expect(profile.releaseIdentity.profileDigest).not.toHaveProperty('value');
    expect(profile.contractSemantics).toEqual({
      sourceObservation: 'source_observation',
      koggNormativePolicy: 'kogg_normative_policy',
      unresolvedGap: 'unresolved_gap',
    });
  });

  it('pins every observation to the exact official revision', () => {
    expect(profile.observedSource).toEqual({
      repository: 'https://github.com/openai/codex',
      commit: SOURCE_SHA,
      committedAt: '2026-07-16T05:38:36Z',
      researchedAt: '2026-07-16',
      immutableCommitUrl: `https://github.com/openai/codex/commit/${SOURCE_SHA}`,
    });

    for (const [id, contract] of Object.entries(profile.contracts)) {
      expect(contract.sources.length).toBeGreaterThan(0);
      for (const source of contract.sources) {
        expect(source).toContain(`github.com/openai/codex/blob/${SOURCE_SHA}/`);
      }
      expect(contract.observationKind).toBe(
        id === 'auth.browser.authorize'
          ? 'observed_authorization_url_construction'
          : 'observed_client_construction',
      );
    }
  });

  it('assigns exact Kogg-owned limits and cancellation policy', () => {
    expect(Object.keys(profile.resourceProfiles).sort()).toEqual(
      Object.keys(RESOURCE_PROFILES).sort(),
    );

    for (const [id, values] of Object.entries(RESOURCE_PROFILES)) {
      const resource = profile.resourceProfiles[id];
      expectExactKeys(resource, [
        'ownership',
        'redirects',
        'limits',
        'cancellation',
      ]);
      expect(Object.keys(resource.limits).sort()).toEqual(
        [...RESOURCE_KEYS, 'contentEncodings'].sort(),
      );
      expect(RESOURCE_KEYS.map((key) => resource.limits[key])).toEqual(values);
      expect(resource.ownership).toBe('kogg_normative_policy');
      expect(resource.redirects).toBe('reject');
      expect(resource.limits.contentEncodings).toEqual(['identity']);
      expect(resource.cancellation).toEqual({
        cancelWithinMs: 2000,
        invalidateGeneration: true,
        abortTransport: true,
        http1: 'destroy_connection',
        http2: 'RST_STREAM',
        connectionReusable: false,
        commitPartialOutputOrToolState: false,
        replayAfterPossiblySent: 'never',
      });
    }

    expectExactKeys(profile.transportPolicy, [
      'ownership',
      'tlsTrust',
      'authorities',
      'loopbackAuthorities',
      'redirects',
      'implicitResourceProfile',
      'headerInventoryScope',
      'deviceAuthorizationLifetimeMs',
      'sseIdleReset',
      'limitEnforcement',
      'jsonDuplicateKeyScan',
    ]);
    expect(profile.transportPolicy).toMatchObject({
      tlsTrust: 'system_trust_store',
      authorities: ['auth.openai.com', 'chatgpt.com'],
      loopbackAuthorities: ['127.0.0.1'],
      implicitResourceProfile: 'forbidden',
      deviceAuthorizationLifetimeMs: 900000,
      sseIdleReset: 'complete_valid_line_or_heartbeat_only',
    });
  });

  it('closes every endpoint request, response, matcher, cancel, and drift shape', () => {
    expect(Object.keys(profile.contracts).sort()).toEqual(CONTRACT_IDS.sort());

    for (const [id, contract] of Object.entries(profile.contracts)) {
      expect(Object.keys(contract.request).sort()).toEqual(REQUEST_KEYS);
      expect(Object.keys(contract.request.headers).sort()).toEqual(
        MATCHER_KEYS,
      );
      expect(Object.keys(contract.request.query).sort()).toEqual(MATCHER_KEYS);
      expect(Object.keys(contract.request.body).sort()).toEqual(MATCHER_KEYS);
      expect(contract.request.additionalFields).toBe('reject');
      expectExactKeys(contract, [
        ...CONTRACT_BASE_KEYS,
        ...(CONTRACT_EXTRA_KEYS[id] ?? []),
      ]);
      expectExactKeys(contract.response, [
        'statuses',
        'fields',
        'additionalFields',
        'unknownActionableVariant',
      ]);
      expectExactKeys(contract.response.statuses, [
        'accepted',
        'other',
        ...(RESPONSE_STATUS_EXTRA_KEYS[id] ?? []),
      ]);
      expectExactKeys(contract.response.fields, MATCHER_KEYS);
      expect(contract.response).toMatchObject({
        additionalFields: 'bounded_native_preservation_only',
        unknownActionableVariant: 'block',
      });
      expect(contract.response.statuses).toBeDefined();
      expect(contract.response.fields).toBeDefined();
      expect(contract.resourceProfile).toBeDefined();
      expect(profile.resourceProfiles[contract.resourceProfile]).toBeDefined();
      expect(contract.cancellation).toBe('use_resource_profile');
      expect(contract.drift).toBe('block_and_redact');
      expect(contract.productionStatus).toBe('blocked');
      expect(contract.blockingGaps.length).toBeGreaterThan(0);
    }

    expectExactKeys(
      profile.contracts['auth.device.user_code'].responseAliases,
      ['user_code'],
    );
    expectExactKeys(
      profile.contracts['auth.device.user_code'].responseSemantics,
      ['interval'],
    );
    expectExactKeys(profile.contracts['auth.refresh'].normativePolicy, [
      'serializePerAccount',
      'compareAndSwapCredentialGeneration',
      'atomicRotation',
    ]);
    expectExactKeys(profile.contracts['auth.revoke'].normativePolicy, [
      'preferRefreshToken',
      'revokeBeforeLocalDelete',
      'localDeleteUnconditional',
      'auditTokenData',
    ]);
    expectExactKeys(
      profile.contracts['auth.browser.callback'].normativePolicy,
      ['acceptedCallbackRequests'],
    );
    expectExactKeys(
      profile.contracts['limits.token_usage_profile'].responseSchema,
      ['required', 'statsOptional', 'dailyBucketRequired'],
    );
    expectExactKeys(
      profile.contracts['entitlement.account_check'].responseSchema,
      [
        'topLevelOptional',
        'accountsWireShapes',
        'normalizedAccountEntryRequired',
        'normalizedAccountEntryOptional',
      ],
    );
    expectExactKeys(profile.contracts['models.catalog'].modelFields, [
      'required',
      'optionalWithObservedDefaults',
    ]);
    expectExactKeys(profile.contracts['responses.sse'].eventProtocol, [
      'dispatchField',
      'recognized',
      'requiredFieldsByType',
      'completedResponseSchema',
      'failureResponseSchema',
      'immediateTerminal',
      'deferredUntilClose',
      'bareDone',
      'malformedOrUnknownObservedClientBehavior',
      'koggBehavior',
    ]);
    expectExactKeys(
      profile.contracts['responses.sse'].eventProtocol.completedResponseSchema,
      [
        'required',
        'optional',
        'usageRequiredWhenPresent',
        'inputTokenDetailsRequiredWhenPresent',
        'inputTokenDetailsOptional',
        'outputTokenDetailsRequiredWhenPresent',
      ],
    );
    expectExactKeys(
      profile.contracts['responses.sse'].eventProtocol.failureResponseSchema,
      ['optionalErrorFields', 'recognizedCodes', 'incompleteOptional'],
    );

    expect(profile.contracts['auth.browser.authorize']).toMatchObject({
      authorizedKoggClient: 'unresolved_must_not_use_first_party_identity',
      observedFirstPartyClientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
      observedFirstPartyIdentityMayBeUsedByKogg: false,
    });
    expect(
      profile.contracts['auth.browser.authorize'].request.query,
    ).toMatchObject({
      required: expect.arrayContaining([
        'originator',
        'id_token_add_organizations',
        'codex_cli_simplified_flow',
      ]),
      optional: ['allowed_workspace_id'],
    });
    expect(profile.contracts['auth.browser.callback']).toMatchObject({
      observedBindHost: '127.0.0.1',
      observedPreferredPorts: [1455, 1457],
      observedFollowupPaths: ['/success', '/cancel'],
      requestSemantics:
        'matching_state_then_error_precedes_code_and_one_nonempty_code_or_error_required',
      normativePolicy: { acceptedCallbackRequests: 1 },
      response: {
        statuses: { accepted: [200, 302, 400], other: 'block' },
        fields: expect.objectContaining({
          optional: expect.arrayContaining([
            'Location',
            'Content-Type',
            'body',
          ]),
        }),
      },
    });
    expect(profile.contracts['auth.device.user_code']).toMatchObject({
      responseAliases: { user_code: ['user_code', 'usercode'] },
      responseSemantics: {
        interval: 'optional_wire_string_parsed_as_u64_missing_defaults_to_0',
      },
      response: {
        fields: expect.objectContaining({
          required: expect.not.arrayContaining(['interval']),
          optional: expect.arrayContaining(['interval']),
          nondeterministic: expect.arrayContaining(['interval']),
        }),
      },
    });
    expect(profile.contracts['auth.device.poll'].overallLifetimeMs).toBe(
      900000,
    );
    expect(
      profile.contracts['auth.device.poll'].response.fields.required,
    ).toEqual(
      expect.arrayContaining([
        'authorization_code',
        'code_challenge',
        'code_verifier',
      ]),
    );
    expect(profile.contextBudget.authoritativeWindowSource).toMatchObject({
      bundledFallback: 'forbidden',
    });
    expect(profile.contextBudget.observedWindowResolution).toMatchObject({
      effectiveWindowFormula:
        'floor(resolved_context_window * effective_context_window_percent / 100)',
      autoCompactFormula:
        'if_resolved_context_window_then_min(explicit_auto_compact_token_limit_or_floor(resolved_context_window * 9 / 10), floor(resolved_context_window * 9 / 10))_else_explicit_auto_compact_token_limit',
    });
    expect(
      profile.contracts['auth.device.token_exchange'].request,
    ).toMatchObject({
      contentType: 'application/x-www-form-urlencoded',
      body: { required: expect.arrayContaining(['code', 'code_verifier']) },
    });
    expect(profile.contracts['auth.refresh'].request.body.required).toEqual([
      'client_id',
      'grant_type',
      'refresh_token',
    ]);
    expect(profile.contracts['auth.revoke'].request).toMatchObject({
      contentType: 'application/json',
      body: {
        required: ['token', 'token_type_hint'],
        optional: ['client_id'],
      },
    });
    expect(profile.contracts['identity.jwt_claims'].request).toMatchObject({
      method: 'LOCAL_PARSE',
      authority: null,
      path: 'id_token.payload',
      body: { required: ['id_token'] },
    });
    expect(profile.contracts['limits.token_usage_profile'].request.path).toBe(
      '/backend-api/wham/profiles/me',
    );
    expect(
      profile.contracts['limits.token_usage_profile'].response.fields.required,
    ).toEqual(['stats']);
    expect(profile.contracts['entitlement.account_check']).toMatchObject({
      observedPurpose:
        'account_listing_and_default_selection_not_affirmative_entitlement',
      entitlementInterpretation: 'forbidden_without_affirmative_contract',
      request: { path: '/backend-api/wham/accounts/check' },
      response: {
        fields: expect.objectContaining({
          optional: expect.arrayContaining([
            'accounts',
            'account_ordering',
            'default_account_id',
          ]),
        }),
      },
    });
    expect(profile.contracts['models.catalog'].modelFields.required).toEqual(
      expect.arrayContaining([
        'display_name',
        'supported_reasoning_levels',
        'base_instructions',
        'supports_parallel_tool_calls',
        'experimental_supported_tools',
      ]),
    );
    expect(
      profile.contracts['models.catalog'].modelFields
        .optionalWithObservedDefaults,
    ).toEqual(
      expect.arrayContaining([
        'description',
        'default_reasoning_level',
        'availability_nux',
        'upgrade',
        'default_verbosity',
        'apply_patch_tool_type',
        'context_window',
        'auto_compact_token_limit',
        'multi_agent_version',
      ]),
    );
    expect(profile.contracts['models.catalog'].modelFields.required).toEqual(
      expect.not.arrayContaining([
        'description',
        'availability_nux',
        'upgrade',
        'default_verbosity',
        'apply_patch_tool_type',
      ]),
    );
    expect(profile.contracts['limits.usage'].response.fields).toMatchObject({
      required: ['plan_type'],
      optional: expect.arrayContaining([
        'rate_limit',
        'credits',
        'spend_control',
        'additional_rate_limits',
        'rate_limit_reached_type',
        'rate_limit_reset_credits',
      ]),
    });
    expect(profile.contracts['responses.sse'].request.body).toMatchObject({
      required: expect.not.arrayContaining(['instructions', 'tools']),
      optional: expect.arrayContaining(['instructions', 'tools']),
      fixed: expect.arrayContaining([
        'tool_choice=auto',
        'include=["reasoning.encrypted_content"]',
      ]),
    });
    expect(profile.contracts['responses.sse'].eventProtocol).toMatchObject({
      recognized: expect.arrayContaining(['response.metadata']),
      immediateTerminal: 'response.completed',
      bareDone: 'not_recognized',
      koggBehavior: 'block_and_cancel_without_effect',
    });
    expect(
      Object.keys(
        profile.contracts['responses.sse'].eventProtocol.requiredFieldsByType,
      ).sort(),
    ).toEqual(
      [...profile.contracts['responses.sse'].eventProtocol.recognized].sort(),
    );
    expect(
      profile.contracts['responses.sse'].eventProtocol.requiredFieldsByType[
        'response.completed'
      ],
    ).toEqual(['response.id']);
    expect(profile.contracts['responses.sse'].response.fields.optional).toEqual(
      expect.arrayContaining([
        'header.openai-model',
        'header.x-reasoning-included',
        'header.x-request-id',
        'header.x-codex-turn-state',
        'header.x-<limit>-primary-used-percent',
        'header.x-codex-credits-balance',
      ]),
    );
    expect(profile.contracts['auth.api_key_token_exchange']).toMatchObject({
      ownership: 'source_observation',
      observedFirstPartyBehavior: 'best_effort_after_browser_token_exchange',
      koggSendPolicy: 'forbidden',
      paidApiFallback: 'forbidden',
      request: {
        method: 'POST',
        authority: 'auth.openai.com',
        path: '/oauth/token',
        contentType: 'application/x-www-form-urlencoded',
        body: expect.objectContaining({
          required: expect.arrayContaining([
            'grant_type',
            'client_id',
            'requested_token',
            'subject_token',
            'subject_token_type',
          ]),
        }),
      },
    });
    expect(profile.contracts['compaction.v1'].request.path).toBe(
      '/backend-api/codex/responses/compact',
    );
    expect(profile.contracts['compaction.v1'].request.headers.required).toEqual(
      expect.arrayContaining([
        'originator',
        'User-Agent',
        'version',
        'session-id',
        'thread-id',
        'x-codex-installation-id',
        'x-codex-window-id',
      ]),
    );
    expect(profile.contracts['compaction.v1'].request.headers.optional).toEqual(
      expect.arrayContaining(['x-codex-turn-metadata']),
    );
    expect(profile.contracts['compaction.v1'].request.body).toMatchObject({
      required: [
        'model',
        'input',
        'parallel_tool_calls',
        'reasoning',
        'prompt_cache_key',
      ],
      optional: expect.arrayContaining(['instructions', 'tools']),
    });
    expect(profile.contracts['compaction.v1']).toMatchObject({
      responseItemTypes: expect.arrayContaining([
        'compaction',
        'compaction_summary',
        'context_compaction',
      ]),
      observedUnknownItemBehavior: 'deserializes_to_payload_free_Other',
    });
    expect(profile.contracts['compaction.v2'].request.path).toBe(
      '/backend-api/codex/responses',
    );
    expect(profile.contracts['compaction.v2'].request.body.fixed).toContain(
      'input includes exactly one {"type":"compaction_trigger"}',
    );
    expect(profile.contracts['compaction.v2'].response.fields).toMatchObject({
      required: ['exactly_one_terminal_compaction_item.encrypted_content'],
      optional: expect.arrayContaining([
        'exactly_one_terminal_compaction_item.id',
        'exactly_one_terminal_compaction_item.internal_chat_message_metadata_passthrough',
      ]),
      fixed: ['item.type=compaction|compaction_summary'],
    });
  });

  it('preserves bounded unknown protocol data without exposing raw values', () => {
    expectExactKeys(profile.unknownResponsePolicy, [
      'ownership',
      'nativeProtocolState',
      'diagnostics',
      'display',
      'objectKeys',
      'arrayOrder',
      'duplicateKeys',
      'invalidUtf8',
      'nonFiniteNumbers',
      'unknownDiscriminants',
    ]);
    expect(profile.unknownResponsePolicy).toMatchObject({
      nativeProtocolState: 'preserve_bounded_raw_before_typed_projection',
      diagnostics: 'metadata_only_no_raw_values',
      display: 'metadata_only_no_raw_values',
      objectKeys: 'preserve',
      arrayOrder: 'preserve',
      duplicateKeys: 'reject',
      invalidUtf8: 'reject',
      nonFiniteNumbers: 'reject',
      unknownDiscriminants: 'block_if_actionability_unresolved',
    });
  });

  it('denies sends because exact context accounting is unresolved', () => {
    expectExactKeys(profile.contextBudget, [
      'ownership',
      'productionStatus',
      'sendPolicy',
      'authoritativeWindowSource',
      'observedWindowResolution',
      'observedEstimator',
      'requiredExactAccounting',
      'compactionModes',
    ]);
    expectExactKeys(profile.contextBudget.authoritativeWindowSource, [
      'ownership',
      'source',
      'selection',
      'bundledFallback',
      'requiredFields',
    ]);
    expectExactKeys(profile.contextBudget.observedWindowResolution, [
      'ownership',
      'observedDefaultEffectivePercent',
      'observedDefaultIsAggregateHeadroomOnly',
      'effectiveWindowFormula',
      'autoCompactFormula',
      'sources',
    ]);
    expectExactKeys(profile.contextBudget.observedEstimator, [
      'ownership',
      'algorithm',
      'version',
      'classification',
      'mayAuthorizeSend',
      'sources',
    ]);
    expectExactKeys(profile.contextBudget.observedEstimator.algorithm, [
      'aggregate',
      'tokenConversion',
      'ordinaryItems',
      'encryptedReasoningOrCompaction',
    ]);
    expectExactKeys(profile.contextBudget.requiredExactAccounting, [
      'ownership',
      'tokenizer',
      'tokenizerVersion',
      'serializedFields',
      'outputAllowance',
      'safetyMargin',
      'unknownItemPolicy',
      'missingUsagePolicy',
    ]);
    expectExactKeys(profile.contextBudget.compactionModes, [
      'ownership',
      'v1',
      'v2',
      'sources',
    ]);
    expect(profile.contextBudget).toMatchObject({
      productionStatus: 'blocked',
      sendPolicy: 'deny',
      observedEstimator: {
        algorithm: {
          aggregate:
            'approx_tokens(base_instructions) + sum(estimate_item_token_count(item))',
          tokenConversion: 'ceil(estimated_model_visible_bytes/4)',
          ordinaryItems:
            'serialized_JSON_bytes_with_profiled_image_and_encrypted_function_output_replacements',
          encryptedReasoningOrCompaction:
            'max(floor(base64_encoded_length * 3 / 4) - 650, 0)_bytes_before_token_conversion',
        },
        classification: 'coarse_lower_bound_only',
        mayAuthorizeSend: false,
      },
      requiredExactAccounting: {
        tokenizer: 'unresolved',
        tokenizerVersion: 'unresolved',
        outputAllowance: 'unresolved',
        safetyMargin: 'unresolved',
      },
    });
    expect(
      profile.contextBudget.requiredExactAccounting.serializedFields,
    ).toEqual(
      expect.arrayContaining([
        'model',
        'instructions',
        'input',
        'tools',
        'tool_choice',
        'parallel_tool_calls',
        'reasoning',
        'store',
        'stream',
        'stream_options',
        'include',
        'service_tier',
        'prompt_cache_key',
        'text',
        'client_metadata',
        'all_native_items_modalities_and_tool_results',
      ]),
    );
  });

  it('maps all 14 unresolved gaps to blocked capabilities and evidence', () => {
    expect(Object.keys(profile.unresolvedContracts).sort()).toEqual(GAP_IDS);
    for (const [id, gap] of Object.entries(profile.unresolvedContracts)) {
      expectExactKeys(gap, ['disposition', 'blockedCapabilities', 'sources']);
      expect(gap.disposition).toBe(DISPOSITION);
      expect(gap.blockedCapabilities.length).toBeGreaterThan(0);
      expect(gap.sources.length).toBeGreaterThan(0);
      expect(evidence).toContain(`\`${id}\``);
      for (const capabilityId of gap.blockedCapabilities) {
        expect(profile.capabilities[capabilityId]).toBeDefined();
        expect(profile.capabilities[capabilityId].dependencies).toContain(id);
      }
    }

    for (const capability of Object.values(profile.capabilities)) {
      expectExactKeys(capability, ['state', 'sendPolicy', 'dependencies']);
      expect(capability.state).toBe('blocked');
      expect(capability.sendPolicy).toBe('deny');
      expect(capability.dependencies.length).toBeGreaterThan(0);
      for (const gapId of capability.dependencies) {
        expect(profile.unresolvedContracts[gapId]).toBeDefined();
      }
    }

    for (const [capabilityId, capability] of Object.entries(
      profile.capabilities,
    )) {
      for (const gapId of capability.dependencies) {
        expect(
          profile.unresolvedContracts[gapId].blockedCapabilities,
        ).toContain(capabilityId);
      }
    }

    for (const contract of Object.values(profile.contracts)) {
      expect(contract.blockingGaps).toContain('RESOURCE_CEILINGS');
      expect(contract.blockingGaps).toContain('ACTIONABILITY_CLASSIFICATION');
      for (const gapId of contract.blockingGaps) {
        expect(profile.unresolvedContracts[gapId]).toBeDefined();
      }
    }
  });

  it('defines non-circular candidate, profile, provenance, and trust rules', () => {
    expectExactKeys(profile.releaseIdentity, [
      'ownership',
      'candidateRoot',
      'candidatePreparation',
      'membershipTool',
      'membershipEnumeration',
      'expectedEntries',
      'packageJsonMembership',
      'binMembership',
      'unexpectedEntries',
      'detachedExclusions',
      'rejectedEntries',
      'candidateManifest',
      'candidateDigest',
      'profileDigest',
      'documentPolicy',
      'attestationDigest',
      'signature',
      'timestampPolicy',
      'signingRoles',
      'trustRoots',
      'attestations',
      'enablementManifest',
      'runtime',
    ]);
    expectExactKeys(profile.releaseIdentity.candidatePreparation, [
      'precondition',
      'commands',
      'postcondition',
    ]);
    expectExactKeys(profile.releaseIdentity.membershipTool, [
      'name',
      'version',
      'command',
    ]);
    expectExactKeys(profile.releaseIdentity.candidateManifest, [
      'shape',
      'entryKeys',
      'canonicalization',
      'pathNormalization',
      'pathOrdering',
      'executableMode',
      'regularMode',
      'fileDigest',
      'duplicateJsonKeys',
      'sizeRepresentation',
    ]);
    expectExactKeys(profile.releaseIdentity.candidateDigest, [
      'algorithm',
      'domain',
      'framing',
      'encoding',
    ]);
    expectExactKeys(profile.releaseIdentity.profileDigest, [
      'algorithm',
      'domain',
      'framing',
      'encoding',
      'selfDigestField',
    ]);
    expectExactKeys(profile.releaseIdentity.documentPolicy, [
      'appliesTo',
      'canonicalization',
      'duplicateJsonKeys',
      'additionalFields',
      'integerRange',
    ]);
    expectExactKeys(profile.releaseIdentity.attestationDigest, [
      'algorithm',
      'browserDomain',
      'deviceDomain',
      'framing',
      'boundary',
      'encoding',
    ]);
    expectExactKeys(profile.releaseIdentity.signature, [
      'envelope',
      'envelopeShape',
      'envelopeAdditionalFields',
      'payloadEncoding',
      'payloadTypes',
      'preAuthenticationEncoding',
      'paeFraming',
      'algorithm',
      'signatureEncoding',
      'signatureCount',
      'keyId',
    ]);
    expectExactKeys(profile.releaseIdentity.signature.payloadTypes, [
      'enablement',
      'browserProbe',
      'deviceProbe',
    ]);
    expectExactKeys(profile.releaseIdentity.timestampPolicy, [
      'format',
      'maxClockSkewSeconds',
      'maxValiditySeconds',
    ]);
    expectExactKeys(profile.releaseIdentity.signingRoles, [
      'protectedProbe',
      'enablement',
      'rolesMustBeDistinct',
    ]);
    expectExactKeys(profile.releaseIdentity.trustRoots, [
      'location',
      'distribution',
      'rotationAndRevocation',
      'operationalStatus',
    ]);
    expectExactKeys(profile.releaseIdentity.attestations, [
      'browser',
      'device',
    ]);
    expectExactKeys(profile.releaseIdentity.enablementManifest, [
      'requiredFields',
      'binds',
      'detached',
    ]);
    expectExactKeys(profile.releaseIdentity.runtime, ['blockedProfile']);
    expect(profile.releaseIdentity).toMatchObject({
      ownership: 'kogg_normative_policy',
      candidateRoot: 'dist_after_release_preparation',
      candidatePreparation: {
        precondition: 'clean_checkout_and_dist_absent',
        commands: [
          'npm run build',
          'npm run bundle',
          'npm run prepare:package',
        ],
        postcondition:
          'dist/package.json_exists_and_prepare_package_verification_succeeded',
      },
      membershipTool: {
        name: 'npm',
        version: '11.16.0',
        command: ['pack', '--dry-run', '--json', '--ignore-scripts'],
      },
      membershipEnumeration:
        'membershipTool_command_executed_in_candidateRoot_and_exactly_one_pack_result_accepted',
      expectedEntries:
        'exact_regular_file_paths_reported_by_the_single_pack_result_files_array_minus_detachedExclusions',
      packageJsonMembership: 'required_and_reported_by_pack_result',
      binMembership:
        'every_package_json_bin_target_including_kogg_must_resolve_to_one_reported_regular_file',
      unexpectedEntries:
        'reject_any_candidate_root_entry_not_in_expectedEntries_or_detachedExclusions',
      detachedExclusions: [
        'chatgpt-enablement-v1.dsse.json',
        'chatgpt-browser-probe-v1.dsse.json',
        'chatgpt-device-probe-v1.dsse.json',
      ],
      candidateManifest: {
        shape: '{"files":[entry,...]}',
        entryKeys: ['path', 'mode', 'size', 'sha256'],
        canonicalization: 'RFC8785_JCS_UTF8',
        pathNormalization: 'UTF8_NFC',
        pathOrdering: 'unsigned_UTF8_byte_order',
        executableMode: '0755_declared_bin_targets_only',
        regularMode: '0644',
        fileDigest: 'lowercase_hex_SHA256_exact_file_bytes_without_prefix',
      },
      candidateDigest: {
        algorithm: 'SHA-256',
        domain: 'kogg-candidate-payload-v1',
        framing: 'UTF8(domain) || NUL || JCS(candidate_manifest)',
        encoding: 'sha256:<lowercase_hex>',
      },
      profileDigest: {
        algorithm: 'SHA-256',
        domain: 'kogg-chatgpt-compatibility-profile-v1',
        framing: 'UTF8(domain) || NUL || JCS(entire_machine_profile)',
        encoding: 'sha256:<lowercase_hex>',
        selfDigestField: 'forbidden',
      },
      documentPolicy: {
        canonicalization: 'RFC8785_JCS_UTF8',
        duplicateJsonKeys: 'reject_before_canonicalization',
        additionalFields: 'reject',
        integerRange: 'JSON_safe_integer_only',
      },
      attestationDigest: {
        algorithm: 'SHA-256',
        browserDomain: 'kogg-chatgpt-browser-attestation-v1',
        deviceDomain: 'kogg-chatgpt-device-attestation-v1',
        boundary: 'canonical_attestation_payload_not_DSSE_envelope',
        encoding: 'sha256:<lowercase_hex>',
      },
      signature: {
        envelope: 'DSSE_v1',
        envelopeAdditionalFields: 'reject',
        payloadEncoding: 'canonical_padded_base64',
        preAuthenticationEncoding: 'DSSEv1 PAE',
        algorithm: 'Ed25519_RFC8032',
        signatureEncoding: 'canonical_padded_base64',
        signatureCount: 'exactly_one_allowed_key_for_payload_role',
        keyId: 'lowercase_hex_SHA256_DER_SubjectPublicKeyInfo',
      },
      timestampPolicy: {
        format: 'RFC3339_UTC_seconds',
        maxClockSkewSeconds: 300,
        maxValiditySeconds: 2592000,
      },
      trustRoots: {
        location: 'external_to_candidate_and_detached_envelopes',
        distribution: 'authenticated_base_release_or_OS_package_provenance',
        operationalStatus: 'unresolved_blocking',
      },
      runtime: {
        blockedProfile: 'reject_enablement',
      },
    });

    expect(profile.releaseIdentity.rejectedEntries).toEqual(
      expect.arrayContaining([
        'absolute_path',
        'dot_segment',
        'dotdot_segment',
        'backslash',
        'NUL',
        'symlink',
        'hardlink',
        'device',
        'socket',
        'duplicate_NFC_path',
        'casefold_collision',
        'unsafe_size',
        'unsafe_mode',
      ]),
    );
    expect(profile.releaseIdentity.signingRoles).toEqual({
      protectedProbe: 'probe_signing_role',
      enablement: 'release_enablement_signing_role',
      rolesMustBeDistinct: true,
    });
    expect(profile.releaseIdentity.attestations.browser.mode).toBe('browser');
    expect(profile.releaseIdentity.attestations.device.mode).toBe('device');
    expect(profile.releaseIdentity.enablementManifest.binds).toEqual(
      expect.arrayContaining([
        'candidateDigest',
        'profileDigest',
        'browserAttestationDigest',
        'deviceAttestationDigest',
      ]),
    );
    expect(profile.releaseIdentity.enablementManifest.requiredFields).toEqual(
      expect.arrayContaining([
        'repository',
        'sourceCommit',
        'profileId',
        'packageName',
        'packageVersion',
        'entrypoint',
        'workflowPathAtCommit',
        'builderIdentity',
        'createdAt',
        'expiresAt',
        'keyId',
      ]),
    );
    for (const attestation of Object.values(
      profile.releaseIdentity.attestations,
    )) {
      expectExactKeys(attestation, [
        'mode',
        'result',
        'requiredFields',
        'binds',
      ]);
      expect(attestation.requiredFields).toEqual(
        expect.arrayContaining([
          'candidateDigest',
          'profileDigest',
          'probeVersion',
          'profileId',
          'nonce',
          'mode',
          'result',
          'secretScanResult',
          'cleanupResult',
          'toolIsolationResult',
          'workflowRunUrl',
          'builderIdentity',
        ]),
      );
    }
  });

  it('pins public, non-secret digest, DSSE, and signature vectors', () => {
    const vectors = profile.publicTestVectors;
    expectExactKeys(vectors, [
      'classification',
      'candidateFile',
      'candidateDigest',
      'profileDigest',
      'browserAttestationDigest',
      'deviceAttestationDigest',
      'dssePae',
      'ed25519',
    ]);
    expectExactKeys(vectors.candidateFile, [
      'path',
      'bytesBase64',
      'lowercaseHex',
    ]);
    expectExactKeys(vectors.candidateDigest, ['canonicalJson', 'lowercaseHex']);
    expectExactKeys(vectors.profileDigest, ['canonicalJson', 'lowercaseHex']);
    expectExactKeys(vectors.browserAttestationDigest, [
      'canonicalJson',
      'lowercaseHex',
    ]);
    expectExactKeys(vectors.deviceAttestationDigest, [
      'canonicalJson',
      'lowercaseHex',
    ]);
    expectExactKeys(vectors.dssePae, [
      'payloadType',
      'payload',
      'preAuthenticationEncoding',
    ]);
    expectExactKeys(vectors.ed25519, [
      'source',
      'publicKeySpkiDerBase64',
      'messageBase64',
      'signatureBase64',
      'expectedVerification',
    ]);
    expect(vectors.classification).toBe('public_non_secret_test_data');
    expect(
      createHash('sha256')
        .update(Buffer.from(vectors.candidateFile.bytesBase64, 'base64'))
        .digest('hex'),
    ).toBe(vectors.candidateFile.lowercaseHex);
    expect(JSON.parse(vectors.candidateDigest.canonicalJson)).toEqual({
      files: [
        {
          mode: '0644',
          path: vectors.candidateFile.path,
          sha256: vectors.candidateFile.lowercaseHex,
          size: 3,
        },
      ],
    });
    expect(
      sha256Domain(
        profile.releaseIdentity.candidateDigest.domain,
        vectors.candidateDigest.canonicalJson,
      ),
    ).toBe(vectors.candidateDigest.lowercaseHex);
    expect(
      sha256Domain(
        profile.releaseIdentity.profileDigest.domain,
        vectors.profileDigest.canonicalJson,
      ),
    ).toBe(vectors.profileDigest.lowercaseHex);
    expect(
      sha256Domain(
        profile.releaseIdentity.attestationDigest.browserDomain,
        vectors.browserAttestationDigest.canonicalJson,
      ),
    ).toBe(vectors.browserAttestationDigest.lowercaseHex);
    expect(
      sha256Domain(
        profile.releaseIdentity.attestationDigest.deviceDomain,
        vectors.deviceAttestationDigest.canonicalJson,
      ),
    ).toBe(vectors.deviceAttestationDigest.lowercaseHex);
    expect(vectors.dssePae.preAuthenticationEncoding).toBe(
      `DSSEv1 ${Buffer.byteLength(vectors.dssePae.payloadType)} ${vectors.dssePae.payloadType} ${Buffer.byteLength(vectors.dssePae.payload)} ${vectors.dssePae.payload}`,
    );
    expect(
      verify(
        null,
        Buffer.from(vectors.ed25519.messageBase64, 'base64'),
        createPublicKey({
          key: Buffer.from(vectors.ed25519.publicKeySpkiDerBase64, 'base64'),
          format: 'der',
          type: 'spki',
        }),
        Buffer.from(vectors.ed25519.signatureBase64, 'base64'),
      ),
    ).toBe(vectors.ed25519.expectedVerification);
  });

  it('links the normative JSON from the human evidence record', () => {
    expect(evidence).toContain(
      '[machine-readable profile](./chatgpt-codex-compatibility-profile.v1.json)',
    );
    expect(evidence).toContain('**Profile state:** **blocked**');
    expect(evidence).toContain(
      'Completing #24 does not enable downstream issue #25',
    );
  });
});
