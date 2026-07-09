export function createParameterReader(params = {}) {
  return {
    get(name, defaultValue) {
      const value = params[name];
      return value === undefined ? defaultValue : value;
    },

    require(name) {
      const value = params[name];

      if (value === undefined || value === null || value === "") {
        throw parameterError("RUNTIME_PARAMETER_REQUIRED", `required runtime parameter is missing: ${name}`);
      }

      return value;
    },

    string(name, defaultValue) {
      const value = this.get(name, defaultValue);

      if (value === undefined) {
        return undefined;
      }

      if (typeof value !== "string") {
        throw parameterError("RUNTIME_PARAMETER_TYPE_INVALID", `runtime parameter ${name} must be a string`);
      }

      return value;
    },

    requiredString(name) {
      const value = this.require(name);

      if (typeof value !== "string") {
        throw parameterError("RUNTIME_PARAMETER_TYPE_INVALID", `runtime parameter ${name} must be a string`);
      }

      return value;
    },

    stringArray(name, defaultValue) {
      const value = this.get(name, defaultValue);

      if (value === undefined) {
        return undefined;
      }

      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw parameterError("RUNTIME_PARAMETER_TYPE_INVALID", `runtime parameter ${name} must be a string array`);
      }

      return value;
    },

    requiredStringArray(name) {
      const value = this.require(name);

      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw parameterError("RUNTIME_PARAMETER_TYPE_INVALID", `runtime parameter ${name} must be a string array`);
      }

      return value;
    }
  };
}

function parameterError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
