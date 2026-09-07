import * as crypto from 'crypto';
import * as jose from 'jose';

export async function generateToken(apiName: string, privateSecret: string, requestMethod: string, requestPath: string): Promise<string> {
    const pathWithoutQuery = requestPath.split('?')[0];
    const uri = requestMethod + ' api.coinbase.com' + pathWithoutQuery;
    
    // The CDP Ed25519 secret is a 64-byte base64 string. 
    // We extract the first 32 bytes (private seed) and wrap it in standard PKCS8 ASN.1 DER for Ed25519.
    const keyBuf = Buffer.from(privateSecret, 'base64');
    const privateSeed = keyBuf.subarray(0, 32);
    const asn1Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
    const der = Buffer.concat([asn1Prefix, privateSeed]);

    const privateKey = crypto.createPrivateKey({
        key: der,
        format: 'der',
        type: 'pkcs8'
    });

    const token = await new jose.SignJWT({
        iss: 'coinbase-cloud',
        nbf: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 120,
        sub: apiName,
        uri,
    })
    .setProtectedHeader({ alg: 'EdDSA', kid: apiName, nonce: crypto.randomBytes(16).toString('hex') })
    .sign(privateKey);

    return token;
}
