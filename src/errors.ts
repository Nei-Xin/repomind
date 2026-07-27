export type RepoMindErrorCode =
  | "REPOSITORY_NOT_INITIALIZED"
  | "NOT_A_GIT_REPOSITORY"
  | "PATH_OUTSIDE_REPOSITORY"
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_OPEN"
  | "MEMORY_NOT_FOUND"
  | "INVALID_INPUT"
  | "GIT_INSPECTION_FAILED"
  | "CAPABILITY_UNAVAILABLE"
  | "STORAGE_UNAVAILABLE";

export class RepoMindError extends Error {
  constructor(
    public readonly code: RepoMindErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RepoMindError";
  }
}
