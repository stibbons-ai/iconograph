import parse from "spdx-expression-parse";

export interface PackageLicense {
  name: string;
  version: string;
  license: unknown;
}

export interface LicenseException {
  name: string;
  version: string;
  license: string;
  reason: string;
}

const permissiveLicenses: Readonly<Record<string, true>> = {
  MIT: true,
  "Apache-2.0": true,
  ISC: true,
  "BSD-2-Clause": true,
  "BSD-3-Clause": true,
  "0BSD": true,
  "CC0-1.0": true,
  Unlicense: true,
  "BlueOak-1.0.0": true,
};

function permitted(expression: parse.Info): boolean {
  if ("conjunction" in expression) {
    return expression.conjunction === "or"
      ? permitted(expression.left) || permitted(expression.right)
      : permitted(expression.left) && permitted(expression.right);
  }
  return (
    !expression.exception && !expression.plus && permissiveLicenses[expression.license] === true
  );
}

export function validateAllowlist(value: unknown): LicenseException[] {
  if (!Array.isArray(value)) throw new Error("Licence allowlist must be an array");
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !["name", "version", "license", "reason"].every(
        (key) => typeof entry[key] === "string" && entry[key].trim().length > 0,
      ) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(entry.version) ||
      /[*^~<>|\s]/.test(entry.name)
    ) {
      throw new Error(
        "Every licence exception requires an exact package, version, licence and reason",
      );
    }
    const key = JSON.stringify([entry.name, entry.version, entry.license]);
    if (seen.has(key)) throw new Error(`Duplicate licence exception: ${key}`);
    seen.add(key);
  }
  return value;
}

export function licenseViolation(
  pkg: PackageLicense,
  allowlist: readonly LicenseException[] = [],
): string | undefined {
  const license = typeof pkg.license === "string" ? pkg.license : "<missing-or-non-string>";
  if (
    allowlist.some(
      (entry) =>
        entry.name === pkg.name &&
        entry.version === pkg.version &&
        entry.license === license &&
        entry.reason.trim().length > 0,
    )
  ) {
    return undefined;
  }
  if (typeof pkg.license !== "string") return "Missing or non-string licence metadata";
  let expression: parse.Info;
  try {
    expression = parse(pkg.license);
  } catch {
    return `Unknown or invalid SPDX licence expression: ${pkg.license}`;
  }
  return permitted(expression) ? undefined : `Licence requires review: ${pkg.license}`;
}
