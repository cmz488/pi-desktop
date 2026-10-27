import { generateKeyPairSync, sign, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 自签 TLS 证书（纯 Node 生成，不依赖 openssl 或外部包）。
 *
 * 接口：`ensureCertificate({ directory, hosts })` 返回 `{ cert, key, certPath, keyPath }`
 *   （PEM 文本与落盘路径）；同一目录下已有证书且仍覆盖 hosts 时直接复用。
 * 不变量：
 *   - 私钥只在本地落盘（0600），不进日志、不进包、不进文档；
 *   - SAN 覆盖调用方给出的所有主机名/IP，否则手机连上会因证书不匹配而失败；
 *   - 复用前检查有效期与覆盖范围，不把过期证书当可用。
 * 为什么自签：局域网没有公共 CA 能给 `192.168.x.x` 签证书；自签 + 首次指纹确认是这条路
 *   的唯一可行形态。浏览器会提示不受信任，这是预期行为，不能靠关闭校验绕过。
 * 错误：OpenSSL 拒绝该编码时 `tls.createSecureContext` 会抛错；调用方据此失败而不是降级到 HTTP。
 *
 * 编码说明：X.509 需要 DER。这里只手工编码 TBS（版本/序列号/算法/签发者/有效期/主体/
 * SPKI/扩展），签名算法值与 SPKI 直接取自 `node:crypto`，避免重复实现椭圆曲线细节。
 */

/** DER 长度前缀。 */
function derLength(size) {
  if (size < 0x80) return Buffer.from([size]);
  const bytes = [];
  let value = size;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** TLV。 */
function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const sequence = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));

/** 正整数；支持 BigInt（证书序列号可能超过 2^53）；前导 0x00 防止被解释成负数。 */
function integer(value) {
  const target = typeof value === "bigint" ? value : BigInt(value);
  const bytes = [];
  let rest = target;
  while (rest > 0n) {
    bytes.unshift(Number(rest & 0xffn));
    rest >>= 8n;
  }
  if (!bytes.length) bytes.push(0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}

/** OID：首字节 = 40*a + b，其后按 7 位分组。 */
function oid(dotted) {
  const parts = dotted.split(".").map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [];
    let value = part;
    do {
      chunk.unshift(value & 0x7f);
      value >>= 7;
    } while (value > 0);
    for (let index = 0; index < chunk.length - 1; index += 1) chunk[index] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const NULL = tlv(0x05, Buffer.alloc(0));

/** UTCTime：RFC 5280 要求 YYMMDDHHMMSSZ（1950–2049）。 */
function utcTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z";
  return tlv(0x17, Buffer.from(text, "ascii"));
}

/**
 * X.520 的 commonName，按 X.509 的层级包好：
 * Name ::= RDNSequence ::= SEQUENCE OF RDN；RDN ::= SET OF AttributeTypeAndValue。
 * 少掉外层 SEQUENCE 会得到 "wrong tag"，这是手工编码 DER 最容易犯的错。
 */
function commonName(value) {
  return sequence(
    set(sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(value, "utf8")))),
  );
}

const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const OID_PRIME256V1 = "1.2.840.10045.3.1.7";
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_SAN = "2.5.29.17";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";

const ecdsaWithSha256 = () => sequence(oid(OID_ECDSA_SHA256));

/** SAN：IP 用 [7]，DNS 用 [2]。 */
function subjectAltName(hosts) {
  const entries = hosts.map((host) => {
    const isIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
    return isIp
      ? tlv(0x87, Buffer.from(host.split(".").map(Number)))
      : tlv(0x82, Buffer.from(host, "ascii"));
  });
  return sequence(...entries);
}

function extensions(hosts) {
  const san = sequence(oid(OID_SAN), tlv(0x04, subjectAltName(hosts)));
  // CA:FALSE —— 自签但不做 CA，避免被当成可签发其它证书。
  const basic = sequence(
    oid(OID_BASIC_CONSTRAINTS),
    tlv(0x01, Buffer.from([0xff])),
    tlv(0x04, tlv(0x30, Buffer.alloc(0))),
  );
  return tlv(0xa3, sequence(san, basic));
}

/** 生成一对 P-256 密钥与自签证书（PEM）。 */
export function createSelfSignedCertificate({ hosts, commonName: name = "pi-desktop" }) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  // generateKeyPairSync 已返回 KeyObject，直接导出 SPKI，不必再包一次。
  const spki = publicKey.export({ type: "spki", format: "der" });
  const serial = randomBytes(8).readBigUInt64BE() & 0x7fff_ffff_ffff_ffffn;
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  const algorithm = ecdsaWithSha256();
  const tbs = sequence(
    // version [0] EXPLICIT v3
    tlv(0xa0, integer(2)),
    integer(serial),
    algorithm,
    commonName(name),
    sequence(utcTime(notBefore), utcTime(notAfter)),
    commonName(name),
    spki,
    extensions(hosts),
  );
  // EC 的 crypto.sign 直接产出 ECDSA-Sig-Value（SEQUENCE{r,s}），正是 X.509 所需。
  const signature = sign("sha256", tbs, privateKey);
  const certificate = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));

  const toPem = (der, label) =>
    `-----BEGIN ${label}-----\n${der
      .toString("base64")
      .match(/.{1,64}/g)
      .join("\n")}\n-----END ${label}-----\n`;

  return {
    cert: toPem(certificate, "CERTIFICATE"),
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** 本地接口的 IPv4（排除回环与链路本地），用于 SAN。 */
export function localHosts(interfaces) {
  const hosts = new Set(["127.0.0.1", "localhost"]);
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (address.address.startsWith("169.254.")) continue;
      hosts.add(address.address);
    }
  }
  return [...hosts];
}

/**
 * 读取或生成工作空间的自签证书。
 *
 * 复用条件：文件存在、有效期剩 30 天以上、且证书里已包含当前全部 hosts。
 * 不满足就重新生成（手机换了网络后 IP 会变，SAN 必须跟着变）。
 */
export async function ensureCertificate({ directory, hosts, commonName: name = "pi-desktop" }) {
  const certPath = join(directory, "tls-cert.pem");
  const keyPath = join(directory, "tls-key.pem");

  try {
    const [cert, key] = await Promise.all([
      readFile(certPath, "utf8"),
      readFile(keyPath, "utf8"),
    ]);
    const parsed = new (await import("node:crypto")).X509Certificate(cert);
    const soon = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const fresh = new Date(parsed.validTo).getTime() > soon;
    const altNames = parsed.subjectAltName ?? "";
    const covered = hosts.every((host) =>
      altNames.includes(host.includes(":") || /^\d/.test(host) ? `IP Address:${host}` : `DNS:${host}`),
    );
    if (fresh && covered) return { cert, key, certPath, keyPath };
  } catch {
    /* 不存在或损坏：重新生成 */
  }

  const created = createSelfSignedCertificate({ hosts, commonName: name });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(certPath, created.cert, { mode: 0o600 });
  await writeFile(keyPath, created.key, { mode: 0o600 });
  return { ...created, certPath, keyPath };
}