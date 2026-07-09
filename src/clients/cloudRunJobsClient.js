import { GoogleAuth } from "google-auth-library";

export function createCloudRunJobsClient({
  auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] }),
  endpoint = "https://run.googleapis.com/v2"
} = {}) {
  const baseUrl = endpoint.replace(/\/+$/, "");

  return {
    async runJob(request) {
      const response = await auth.request({
        method: "POST",
        url: `${baseUrl}/${request.name}:run`,
        data: {
          overrides: request.overrides
        }
      });

      return [response.data];
    }
  };
}
