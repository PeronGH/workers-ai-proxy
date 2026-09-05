// Local JWT tooling. `keygen` writes an Ed25519 keypair to .keys/ and prints the public JWK for
// wrangler.jsonc; `sign` mints a token for a user id and allowed-model regex with the private key.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose';

const KEYS_DIR = '.keys';
const PRIVATE_JWK = `${KEYS_DIR}/private.jwk`;
const PUBLIC_JWK = `${KEYS_DIR}/public.jwk`;

async function keygen(): Promise<void> {
	const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
	await mkdir(KEYS_DIR, { recursive: true });
	await writeFile(PRIVATE_JWK, JSON.stringify(await exportJWK(privateKey)));
	const pub = JSON.stringify(await exportJWK(publicKey));
	await writeFile(PUBLIC_JWK, pub);
	console.log(`Wrote ${PRIVATE_JWK} and ${PUBLIC_JWK}. Set vars.JWT_PUBLIC_KEY in wrangler.jsonc to:\n${pub}`);
}

async function sign(args: string[]): Promise<void> {
	const { values } = parseArgs({ args, options: { sub: { type: 'string' }, models: { type: 'string' } } });
	if (!values.sub || !values.models) throw new Error('usage: jwt sign --sub <user id> --models <regex>');
	new RegExp(values.models); // fail here rather than on every proxied request

	const key = await importJWK(JSON.parse(await readFile(PRIVATE_JWK, 'utf8')), 'EdDSA');
	const token = await new SignJWT({ models: values.models })
		.setProtectedHeader({ alg: 'EdDSA' })
		.setSubject(values.sub)
		.setIssuedAt()
		.sign(key);
	console.log(token);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
	case 'keygen':
		await keygen();
		break;
	case 'sign':
		await sign(rest);
		break;
	default:
		throw new Error('usage: jwt keygen | jwt sign --sub <user id> --models <regex>');
}
