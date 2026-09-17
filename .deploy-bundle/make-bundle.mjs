import fs from "node:fs";

function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let inStr = false;
  let strChar = "";
  while (i < n) {
    const c = src[i];
    const nx = src[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += nx;
        i += 2;
        continue;
      }
      if (c === strChar) inStr = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = true;
      strChar = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && nx === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && nx === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function flatten(code) {
  return (
    code
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== "")
      .join("\n") + "\n"
  );
}

const indexSrc = fs.readFileSync("supabase/functions/broker-mt/index.ts", "utf8");
const brokerSrc = fs.readFileSync("supabase/functions/broker-mt/brokerErrors.ts", "utf8");
const denoSrc = fs.readFileSync("supabase/functions/broker-mt/deno.json", "utf8");

const indexFlat = flatten(stripComments(indexSrc));
const brokerFlat = flatten(stripComments(brokerSrc));

fs.writeFileSync(".deploy-bundle/index.ts", indexFlat);
fs.writeFileSync(".deploy-bundle/brokerErrors.ts", brokerFlat);
fs.writeFileSync(".deploy-bundle/deno.json", denoSrc.trim() + "\n");

console.log("index.ts bytes:", indexFlat.length, "lines:", indexFlat.split("\n").length);
console.log("brokerErrors.ts bytes:", brokerFlat.length, "lines:", brokerFlat.split("\n").length);