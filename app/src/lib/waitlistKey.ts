// The Strike team's waitlist public key (RSA-OAEP, 3072-bit, SHA-256), D46. The route wraps each entry's AES key with
// it (waitlistCrypto.ts); the matching private key is held by the team outside the repository and never committed, so
// the app can write entries but cannot read them back. Rotating it: generate a new pair, replace this PEM and
// WAITLIST_PUBLIC_KEY_ID, and keep the old private key until every entry under the old id is exported or re-encrypted.

/** SHA-256 over the key's SPKI bytes, first 16 hex characters: stored with every entry as `kid`. */
export const WAITLIST_PUBLIC_KEY_ID = "78f2f1d5b4f2568f";

export const WAITLIST_PUBLIC_KEY_PEM = `
-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEArJdtJUUfI3WOD+fLNY+f
q58qr8Phox2z0HHH/taknLIJFIMOxutZ/uC9Nd9H+ULuvy9V6H2K0/9ftEJA6yz3
/GwaI4IbhWQ1zoDf86NK/6v3iZLntrBa1fJAWYzCpiiLqhU34c+KcgPcPpLUyX/l
MGJC9Hmuw0p4+H5fOa8dmviS4TqRvdGkD08ewUMZgsGaeE9QC/yXDHoDVm/p3nSE
aNPI5PMpT59GLCDFcjoagQor4qjgr8ZSBW97T89Fr4T2uLmHDckV/j3wJcQcl/Gp
BQmM3esGypKsvHn3whWi7jODnoH0DSt6+VL+wgwQVpRwDXEUZZUbJfP9d/zwN0X+
AQxzLgOvhhA02OeWZH5qy0fG5DwiVbWCGfGHyxL6yDuZlYlylmPQGLcnZnlGYB8o
E0s7W7MX0C7z1NzZtjaYJnB43QyucDMYJBSKrzE6RzGm+BSRW1ZxCc4CaubadymJ
UKrlnfHyPaEGwd//Za/BM7AGbIpquvtWHhlKj4DQe7Y3AgMBAAE=
-----END PUBLIC KEY-----
`;
