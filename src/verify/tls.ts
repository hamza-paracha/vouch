import { generate } from "selfsigned";

/** Ephemeral interception certificate, never written to disk or installed in an OS trust store. */
export async function interceptionCertificate() {
  const pems = await generate([{ name: "commonName", value: "Vouch local verification" }], {
    keyType: "ec", curve: "P-256", algorithm: "sha256",
    notBeforeDate: new Date(Date.now() - 60_000), notAfterDate: new Date(Date.now() + 86_400_000),
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }, { type: 7, ip: "::1" }] },
    ],
  });
  return { key: pems.private, cert: pems.cert };
}
