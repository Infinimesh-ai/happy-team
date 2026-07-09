import { randomBytes } from "crypto";
import * as privacyKit from "privacy-kit";
import nacl from "tweetnacl";
import { db } from "@/storage/db";
import { decryptBytes, encryptBytes } from "@/modules/encrypt";

function secretPath(accountId: string): string[] {
    return ["team", "user", accountId, "secret-key"];
}

function toBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(bytes.length);
    out.set(bytes);
    return out;
}

export function encodeSecretKey(secretKey: Uint8Array): string {
    return Buffer.from(secretKey).toString("base64url");
}

export function decryptManagedSecretKey(accountId: string, encSecretKey: Uint8Array): Uint8Array<ArrayBuffer> {
    return decryptBytes(secretPath(accountId), toBytes(encSecretKey));
}

export function encryptManagedSecretKey(accountId: string, secretKey: Uint8Array): Uint8Array<ArrayBuffer> {
    return encryptBytes(secretPath(accountId), toBytes(secretKey));
}

export async function createManagedAccount(): Promise<{ accountId: string; publicKey: string; encSecretKey: Uint8Array<ArrayBuffer> }> {
    const secretKey = toBytes(randomBytes(32));
    const keypair = nacl.sign.keyPair.fromSeed(secretKey);
    const publicKey = privacyKit.encodeHex(toBytes(keypair.publicKey));

    const account = await db.account.upsert({
        where: { publicKey },
        update: { updatedAt: new Date() },
        create: { publicKey },
    });

    return {
        accountId: account.id,
        publicKey,
        encSecretKey: encryptManagedSecretKey(account.id, secretKey),
    };
}
