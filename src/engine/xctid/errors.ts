// Typed errors for the x-client-transaction-id generator.
// Vendored + ported from Lqm1/x-client-transaction-id (MIT). See docs/ENGINE-RESEARCH.md §3.

type ErrorOptionsWithCode = { cause?: unknown; code?: string };

export class ClientTransactionError extends Error {
  readonly code: string;
  constructor(message: string, options: ErrorOptionsWithCode = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? 'CLIENT_TRANSACTION_ERROR';
  }
}

export class ClientTransactionInitializationError extends ClientTransactionError {
  constructor(message: string, options: ErrorOptionsWithCode = {}) {
    super(message, {
      code: options.code ?? 'CLIENT_TRANSACTION_INITIALIZATION_ERROR',
      cause: options.cause,
    });
  }
}

export class OnDemandFileUrlResolutionError extends ClientTransactionInitializationError {
  constructor() {
    super('Unable to resolve the X ondemand chunk URL from the homepage runtime.', {
      code: 'ONDEMAND_FILE_URL_RESOLUTION_ERROR',
    });
  }
}

export class OnDemandFileFetchError extends ClientTransactionInitializationError {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  constructor(url: string, status: number, statusText: string) {
    super(`Unable to fetch the X ondemand chunk from "${url}": ${status} ${statusText}.`, {
      code: 'ONDEMAND_FILE_FETCH_ERROR',
    });
    this.url = url;
    this.status = status;
    this.statusText = statusText;
  }
}

export class KeyByteIndicesExtractionError extends ClientTransactionInitializationError {
  constructor() {
    super('Unable to extract key byte indices from the X ondemand chunk.', {
      code: 'KEY_BYTE_INDICES_EXTRACTION_ERROR',
    });
  }
}

export class SiteVerificationKeyNotFoundError extends ClientTransactionInitializationError {
  constructor() {
    super('Unable to find the twitter-site-verification meta tag in the homepage document.', {
      code: 'SITE_VERIFICATION_KEY_NOT_FOUND_ERROR',
    });
  }
}

export class IndicesNotInitializedError extends ClientTransactionError {
  constructor() {
    super(
      'ClientTransaction indices are not initialized. Call initialize() before generating animation data.',
      { code: 'INDICES_NOT_INITIALIZED_ERROR' },
    );
  }
}

export class AnimationFrameDataError extends ClientTransactionInitializationError {
  readonly rowIndex: number;
  constructor(rowIndex: number) {
    super(
      `Unable to build animation data for row ${rowIndex}. The homepage animation markup may have changed.`,
      { code: 'ANIMATION_FRAME_DATA_ERROR' },
    );
    this.rowIndex = rowIndex;
  }
}

export class ClientTransactionNotInitializedError extends ClientTransactionError {
  constructor() {
    super(
      'ClientTransaction has not been initialized. Call initialize() or use ClientTransaction.create() first.',
      { code: 'CLIENT_TRANSACTION_NOT_INITIALIZED_ERROR' },
    );
  }
}

export class HandleXMigrationError extends ClientTransactionError {
  constructor(message: string, options: ErrorOptionsWithCode = {}) {
    super(message, { code: options.code ?? 'HANDLE_X_MIGRATION_ERROR', cause: options.cause });
  }
}

export class XHomePageFetchError extends HandleXMigrationError {
  readonly status: number;
  readonly statusText: string;
  constructor(status: number, statusText: string) {
    super(`Unable to fetch the X homepage: ${status} ${statusText}.`, {
      code: 'X_HOMEPAGE_FETCH_ERROR',
    });
    this.status = status;
    this.statusText = statusText;
  }
}

export class XMigrationRedirectionError extends HandleXMigrationError {
  readonly status: number;
  readonly statusText: string;
  constructor(status: number, statusText: string) {
    super(`Unable to follow the X migration redirect: ${status} ${statusText}.`, {
      code: 'X_MIGRATION_REDIRECTION_ERROR',
    });
    this.status = status;
    this.statusText = statusText;
  }
}

export class XMigrationFormError extends HandleXMigrationError {
  readonly status: number;
  readonly statusText: string;
  constructor(status: number, statusText: string) {
    super(`Unable to submit the X migration form: ${status} ${statusText}.`, {
      code: 'X_MIGRATION_FORM_ERROR',
    });
    this.status = status;
    this.statusText = statusText;
  }
}

export class InterpolationInputError extends ClientTransactionError {
  readonly fromLength: number;
  readonly toLength: number;
  constructor(fromLength: number, toLength: number) {
    super(
      `Interpolation requires arrays of the same length, but received ${fromLength} and ${toLength}.`,
      { code: 'INTERPOLATION_INPUT_ERROR' },
    );
    this.fromLength = fromLength;
    this.toLength = toLength;
  }
}
