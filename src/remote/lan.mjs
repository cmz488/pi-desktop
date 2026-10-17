import { networkInterfaces } from "node:os";

export function privateIPv4(value) {
  const parts = value
    .replace(/^::ffff:/, "")
    .split(".")
    .map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}
export function lanAddresses() {
  const entries = Object.entries(networkInterfaces()).sort(([a], [b]) => {
    const virtual = (name) =>
      /^(docker|veth|br-|virbr|tun|tap|tailscale|wg|zt)/.test(name);
    return Number(virtual(a)) - Number(virtual(b));
  });
  return [
    ...new Set(
      entries
        .flatMap(([, addresses]) => addresses ?? [])
        .filter(
          (address) =>
            !address.internal &&
            address.family === "IPv4" &&
            privateIPv4(address.address),
        )
        .map((address) => address.address),
    ),
  ];
}
