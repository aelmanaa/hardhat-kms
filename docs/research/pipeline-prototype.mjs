import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { Transaction, addr, eip191Signer, authorization } from 'micro-eth-signer';
const sk = secp256k1.utils.randomSecretKey();
const pubU = secp256k1.getPublicKey(sk, false); // 65 bytes
const N = secp256k1.Point.CURVE().n;
// SPKI DER like AWS: build via node crypto? just test raw SEC1 path
const address = addr.fromPublicKey(pubU);
// mock "KMS": returns DER, forces high-S half the time
function kmsSignDER(digest){ let sig = secp256k1.Signature.fromBytes(secp256k1.sign(digest, sk, {prehash:false, format:'compact'}), 'compact');
  if (Math.random()<0.5) sig = new secp256k1.Signature(sig.r, N - sig.s);
  return sig.toBytes('der'); }
function toEthSig(digest, der){
  let sig = secp256k1.Signature.fromBytes(der, 'der');
  if (sig.hasHighS()) sig = new secp256k1.Signature(sig.r, N - sig.s);
  for (const rec of [0,1]) { const p = sig.addRecoveryBit(rec).recoverPublicKey(digest).toBytes(false);
    if (p.every((b,i)=>b===pubU[i])) return { r: sig.r, s: sig.s, yParity: rec }; }
  throw new Error('recovery failed'); }
for (let i=0;i<20;i++){
 const tx = Transaction.prepare({type:'eip1559',to:'0x0000000000000000000000000000000000000001',nonce:BigInt(i),chainId:11155111n,value:1n,maxFeePerGas:10n,maxPriorityFeePerGas:1n,gasLimit:21000n});
 const digest = keccak_256(tx.toBytes(false));
 const s = toEthSig(digest, kmsSignDER(digest));
 const signed = new Transaction(tx.type, {...tx.raw, ...s});
 if (signed.recoverSender().address.toLowerCase()!==address.toLowerCase()) throw new Error('tx mismatch');
 const md = eip191Signer._getHash('hello');
 const d2 = typeof md==='string'? Uint8Array.from(Buffer.from(md.replace(/^0x/,''),'hex')) : md;
 const s2 = toEthSig(d2, kmsSignDER(d2));
 const hex = '0x'+s2.r.toString(16).padStart(64,'0')+s2.s.toString(16).padStart(64,'0')+(27+s2.yParity).toString(16);
 if (!eip191Signer.verify(hex,'hello',address)) throw new Error('191 mismatch');
 const ah = authorization._getHash({chainId:0n,address:'0x0000000000000000000000000000000000000001',nonce:0n});
 const s3 = toEthSig(ah, kmsSignDER(ah));
 if (authorization.getAuthority({chainId:0n,address:'0x0000000000000000000000000000000000000001',nonce:0n,...s3}).toLowerCase()!==address.toLowerCase()) throw new Error('7702');
}
console.log('ok 20 rounds', address);
