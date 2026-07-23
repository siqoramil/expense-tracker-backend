import { BadRequestError, NotFoundError } from '@/core';
import type { User } from '@/models';
import { userRepository } from '@/repositories';

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
    // Allow: empty, 1-2 char initials, safe data: image MIME types, https URLs.
    // Reject SVG (XSS via <script>) and any non-https URL.
    const ok =
      a === '' ||
      /^[A-Z0-9]{1,2}$/.test(a) ||
      /^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(a) ||
      /^https:\/\/[^\s<>"]+$/.test(a);
    if (!ok) throw new BadRequestError('invalid_avatar');
    user.avatar = a;
  }
  if (body.prefs && user.prefs) Object.assign(user.prefs, body.prefs);
  await userRepository.save(user);
  return user;
};
