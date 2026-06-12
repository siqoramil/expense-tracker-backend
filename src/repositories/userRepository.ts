import type { ClientSession } from 'mongoose';
import { User } from '@/models';

// Data access for the User model. Service code receives and mutates the live
// Mongoose document (to update failedLogins, lockedUntil, passwordHash, etc.)
// then calls save() through this layer. Nothing here enforces business rules;
// it only translates method calls into Mongoose operations.
export const userRepository = {
  findById(id: string) {
    return User.findById(id);
  },

  findByEmail(email: string) {
    return User.findOne({ email });
  },

  findByGoogleId(sub: string) {
    return User.findOne({ googleId: sub });
  },

  // Creates a new user document. Throws on duplicate email (code 11000);
  // callers map that via isDuplicateKeyError -> ConflictError.
  create(data: {
    email: string;
    passwordHash: string;
    name: string;
    avatar: string;
    googleId?: string;
  }) {
    return User.create(data);
  },

  // Persists a mutated document. Services mutate fields on the live doc and
  // call this once so a single round-trip flushes all changes atomically.
  save(userDoc: InstanceType<typeof User>) {
    return userDoc.save();
  },

  deleteById(id: unknown, session?: ClientSession | null) {
    return User.deleteOne({ _id: id }, session ? { session } : {});
  },
};
