import { safeStorage } from 'electron';
import { createUnavailableCipher, type SecretCipher } from '@pilot/agent';

/**
 * The shipping cipher: Electron `safeStorage`, which is the macOS Keychain
 * (PR-038).
 *
 * `safeStorage.encryptString` derives its key from an item Electron stores in
 * the login Keychain under the application's name, and `isEncryptionAvailable()`
 * is false when that item cannot be reached — a headless session, a locked
 * Keychain, a Linux box with no libsecret. In that case this module returns a
 * cipher that **refuses**, and `@pilot/agent`'s credential store then declines
 * to write anything at all rather than falling back to plaintext.
 *
 * Isolated in its own file, and it imports `electron`, for the same reason
 * `main/electron-hosts.ts` does: `main/api-key-runtime.ts` is unit-tested and
 * must stay importable outside an Electron main process. The composition root
 * is the only place the two meet.
 *
 * **Never executed here.** There is no macOS in this environment and Electron's
 * `safeStorage` needs a real login Keychain, so every line below is unproven;
 * `docs/handoff.md` §1 step 17 is the check. The AES-GCM cipher in
 * `@pilot/agent` is what the tests and `pnpm demo:apikey` exercise, and it is a
 * real cipher over a key this process holds — the difference on the Mac is
 * *where the key comes from*, not what happens to the credential.
 */

export const SAFE_STORAGE_CIPHER_NAME = 'the macOS Keychain (Electron safeStorage)';

/**
 * Builds the Keychain-backed cipher, or one that refuses.
 *
 * Never throws: a build where `safeStorage` is unusable must still start, and
 * the refusal has to be visible in the profile status rather than as a crash at
 * launch.
 */
export function createSafeStorageCipher(): SecretCipher {
  let available: boolean;
  try {
    available = safeStorage.isEncryptionAvailable();
  } catch {
    return createUnavailableCipher('safeStorage could not be queried on this platform');
  }
  if (!available) {
    return createUnavailableCipher('safeStorage.isEncryptionAvailable() reported false');
  }
  return {
    name: SAFE_STORAGE_CIPHER_NAME,
    available: true,
    seal: (plaintext: string): string => safeStorage.encryptString(plaintext).toString('base64'),
    open: (sealed: string): string => safeStorage.decryptString(Buffer.from(sealed, 'base64')),
  };
}
