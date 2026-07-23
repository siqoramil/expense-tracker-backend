import { OAuth2Client } from 'google-auth-library';
import { ServiceUnavailableError, UnauthorizedError } from '@/core';
import { env } from '@/lib';

// Module-level client, avoids Fastify coupling.
export const googleAudiences = [
  env.google.webClientId,
  env.google.iosClientId,
  env.google.androidClientId,
].filter((id) => id.length > 0);

export const googleClient = googleAudiences.length > 0 ? new OAuth2Client() : null;

export type GooglePayload = {
  email?: string;
  sub?: string;
  name?: string;
  given_name?: string;
  picture?: string;
  email_verified?: boolean;
};

// Verifies an ID token against the configured audiences. Throws
// ServiceUnavailableError('google_auth_disabled') when no client id is
// configured, UnauthorizedError('invalid_google_token') on any verification
// failure or missing payload.
export const verifyGoogleIdToken = async (idToken: string): Promise<GooglePayload> => {
  if (!googleClient || googleAudiences.length === 0) {
    throw new ServiceUnavailableError('google_auth_disabled');
  }
  let payload: GooglePayload | undefined;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: googleAudiences,
    });
    payload = ticket.getPayload();
  } catch {
    throw new UnauthorizedError('invalid_google_token');
  }
  if (!payload) {
    throw new UnauthorizedError('invalid_google_token');
  }
  return payload;
};
