export class LocalParameterResolver {
  async resolveParameters(params) {
    const resolved = {};
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value?.type === "sensitive") {
        const envKey = `LOCAL_SECRET_${key.toUpperCase()}`;
        resolved[key] = process.env[envKey] ?? value.secretRef ?? "";
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }
}
