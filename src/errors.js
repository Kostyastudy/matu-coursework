class MatuError extends Error {
  constructor(message, code = 'MATU_ERROR') {
    super(message);
    this.name = 'MatuError';
    this.code = code;
  }
}

class AuthenticationError extends MatuError {
  constructor() { super('登录已过期，请重新登录码图。', 'AUTH'); }
}

class TransportError extends MatuError {
  constructor(message, ambiguous = false) {
    super(message, 'NETWORK');
    this.ambiguous = ambiguous;
  }
}

module.exports = { MatuError, AuthenticationError, TransportError };
