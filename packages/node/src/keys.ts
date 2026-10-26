// Ed25519 machine identity: the hub stores the public key at pairing and challenges the node on every connect.

import { ed25519 } from "@noble/curves/ed25519.js";
import type { NodeKey } from "./home.ts";

/** Must match NODE_AUTH_PREFIX in packages/core/src/machines.ts. */
export const NODE_AUTH_PREFIX = "owlbot-node-auth:";

export function generateKey(): NodeKey {
  const { secretKey, publicKey } = ed25519.keygen();
  return { secretKey: Buffer.from(secretKey).toString("base64url"), publicKey: Buffer.from(publicKey).toString("base64url") };
}

export function publicKeyOf(secretKey: string): string {
  return Buffer.from(ed25519.getPublicKey(Buffer.from(secretKey, "base64url"))).toString("base64url");
}

/** base64url(ed25519.sign(utf8("owlbot-node-auth:" + nonce), secretKey)) */
export function signChallenge(nonce: string, secretKey: string): string {
  const sig = ed25519.sign(new TextEncoder().encode(NODE_AUTH_PREFIX + nonce), Buffer.from(secretKey, "base64url"));
  return Buffer.from(sig).toString("base64url");
}
