import { confirmDelete, requestDelete } from './account.js';
import { requestEmailChange, verifyEmailChange } from './email.js';
import { forgotPassword, resetPassword, verifyResetCode } from './password.js';
import { getMe, updateMe } from './profile.js';
import { googleSignIn, linkGoogle, login, register } from './session.js';

export { CODE_TTL_SECONDS, VERIFIED_TOKEN_TTL } from './constants.js';
export { googleAudiences, googleClient } from './google.js';
export { initialsFrom, issueAuthCode, requireReauth, verifyAuthCode } from './helpers.js';

// Facade kept as a single object so route handlers stay unchanged:
// authService.register(...), authService.login(...), etc.
export const authService = {
  register,
  login,
  googleSignIn,
  linkGoogle,
  getMe,
  updateMe,
  requestDelete,
  confirmDelete,
  requestEmailChange,
  verifyEmailChange,
  forgotPassword,
  verifyResetCode,
  resetPassword,
};
