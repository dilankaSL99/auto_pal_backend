// Adds the authenticated user to Express's Request type so handlers can read
// `req.user` with full type-safety after the `authenticate` middleware runs.
declare global {
  namespace Express {
    interface AuthUser {
      id: string;
      email: string;
    }
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
