import { BadRequestError, NotFoundError } from '@/core';
import type { User } from '@/models';
import { userRepository } from '@/repositories';

// Remote avatars are limited to the host Google serves profile pictures from,
// which is the only one the server ever writes (googleSignIn / linkGoogle) and
// therefore the only one a client legitimately echoes back. An arbitrary https
// URL would be fetched by the app on every profile render, handing whoever
// owns it the user's IP and User-Agent — and a stolen JWT could plant one.
// The `(?:$|[/?])` closes the host so "googleusercontent.com.evil.test" and
// "…googleusercontent.commercial.example" cannot match.
const AVATAR_HOST_RX = /^https:\/\/[a-z0-9-]+\.googleusercontent\.com(?:$|[/?][^\s<>"]*)$/;

export const getMe = async (userId: string): Promise<InstanceType<typeof User>> => {
  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError();
  return user;
};

export const updateMe = async (
  userId: string,
  body: Partial<{ name: string; avatar: string; prefs: Record<string, unknown> }>,
): Promise<InstanceType<typeof User>> => {
  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError();
  if (body.name) user.name = body.name;
  if (body.avatar !== undefined) {
    const a = body.avatar;
    // Allow: empty, 1-2 char initials, safe data: image MIME types, and remote
    // URLs only on hosts we mint avatars from. Reject SVG (XSS via <script>)
    // and any non-https URL.
    const ok =
      a === '' ||
      /^[A-Z0-9]{1,2}$/.test(a) ||
      /^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(a) ||
      AVATAR_HOST_RX.test(a);
    if (!ok) throw new BadRequestError('invalid_avatar');
    user.avatar = a;
  }
  if (body.prefs && user.prefs) Object.assign(user.prefs, body.prefs);
  await userRepository.save(user);
  return user;
};
