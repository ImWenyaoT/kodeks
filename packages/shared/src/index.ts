export type Ok<T> = {
  ok: true;
  value: T;
};

export type Err<E = string> = {
  ok: false;
  error: E;
};

export type Result<T, E = string> = Ok<T> | Err<E>;

// Creates a successful Result value for service and repository boundaries.
export function ok<T>(value: T): Ok<T> {
  return {
    ok: true,
    value
  };
}

// Creates a failed Result value without throwing across package boundaries.
export function err<E = string>(error: E): Err<E> {
  return {
    ok: false,
    error
  };
}

// Narrows a Result union to its successful branch.
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

// Narrows a Result union to its failed branch.
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}
