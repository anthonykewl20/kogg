import type {
  OperationCorrelations,
  OperationKind,
  OperationRegistryApi,
  OperationSafeCode
} from '../common/operations-protocol';

// diagnostic-coverage: operations.registry, operations.cleanup, operations.admission

export async function runOperation<T>(
  registry: OperationRegistryApi,
  kind: OperationKind,
  work: (activity: () => void) => Promise<T>,
  options: {
    readonly correlations?: OperationCorrelations;
    readonly failureCode?: OperationSafeCode;
    readonly resultFailed?: (result: T) => boolean;
    readonly resultFailureType?: string;
  } = {}
): Promise<T> {
  const operation = await registry.startOperation({ kind, correlations: options.correlations, cancellable: false });
  operation.start();
  operation.active();
  try {
    const result = await work(() => operation.activity());
    operation.activity();
    await operation.cleanup();
    if (options.resultFailed?.(result)) operation.fail(options.failureCode ?? 'OWNER_UNAVAILABLE', options.resultFailureType ?? 'OperationResultError');
    else operation.complete('OPERATIONS_OK');
    return result;
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    if (timedOut) operation.timeout('OPERATION_ABSOLUTE_TIMEOUT');
    let failureCode = options.failureCode ?? 'OWNER_UNAVAILABLE';
    try { await operation.cleanup(); }
    catch {
      // observability-exempt: cleanupOperation emits and persists the specific failure before this terminal classification.
      failureCode = 'CLEANUP_FAILED';
    }
    if (!timedOut) operation.fail(failureCode, error instanceof Error ? error.name : 'UnknownError');
    throw error;
  }
}
