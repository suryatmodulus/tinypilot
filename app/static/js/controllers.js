"use strict";

(function (windows) {
  function getCsrfToken(doc = document) {
    return getCsrfTokenElement(doc).getAttribute("content");
  }

  function getCsrfTokenElement(doc) {
    return doc.querySelector("meta[name='csrf-token']");
  }

  function setCsrfToken(tokenValue) {
    return getCsrfTokenElement(document).setAttribute("content", tokenValue);
  }

  function refreshCsrfToken() {
    return fetch("/")
      .then(function (response) {
        return response.text();
      })
      .then(function (html) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const csrfToken = getCsrfToken(doc);
        setCsrfToken(csrfToken);
        return Promise.resolve();
      })
      .catch(function (error) {
        return Promise.reject("Failed to refresh CSRF token: " + error);
      });
  }

  // Reads a response from an HTTP endpoint that we expect to contain a JSON
  // body. Verifies the HTTP response was successful and the response type is
  // JSON, but doesn't check anything beyond that.
  function readHttpJsonResponse(response) {
    const contentType = response.headers.get("content-type");
    const isJson =
      contentType && contentType.indexOf("application/json") !== -1;

    // Success case is an HTTP 200 response and a JSON body.
    if (response.status === 200 && isJson) {
      return Promise.resolve(response.json());
    }

    // If this is JSON, try to read the error field.
    if (isJson) {
      return response.json().then((responseJson) => {
        if (responseJson.hasOwnProperty("error")) {
          return Promise.reject(new Error(responseJson.error));
        }
        return Promise.reject(new Error("Unknown error"));
      });
    }

    return response.text().then((text) => {
      if (text) {
        return Promise.reject(new Error(text));
      } else {
        return Promise.reject(new Error(response.statusText));
      }
    });
  }

  class ControllerError extends Error {
    /**
     * @param details string with the original error message.
     * @param code (optional) string with the error code, or `undefined` for
     *             non-application or unknown errors.
     */
    constructor(details, code) {
      super(details);
      this.code = code;
    }
  }

  /**
   * Processes response from the backend API.
   * @param response An object as returned by `fetch`
   * @returns {Promise<Object>}
   *    Success case: a JSON response with status 2xx. Promise resolves with
   *                  data from response body.
   *    Error case:   anything else, e.g. non-JSON or status 4xx/5xx. Promise
   *                  rejects with a `ControllerError`.
   *
   */
  async function processJsonResponse(response) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new ControllerError(
        "Malformed API response, content type must be JSON"
      );
    }

    let jsonBody;
    try {
      jsonBody = await response.json();
    } catch (jsonParseError) {
      throw new ControllerError(
        "Malformed API response, JSON body cannot be parsed"
      );
    }

    // Resolve on 2xx response:
    if (response.status >= 200 && response.status < 300) {
      return jsonBody;
    }
    // Reject otherwise:
    throw new ControllerError(
      jsonBody.message || "Unknown error: " + JSON.stringify(jsonBody),
      jsonBody.code
    );
  }

  // Checks TinyPilot-level details of the response. The standard TinyPilot
  // response body contains two fields: "success" (bool) and "error" (string)
  // A message indicates success if success is true and error is non-null.
  function checkJsonSuccess(response) {
    if (response.hasOwnProperty("error") && response.error) {
      return Promise.reject(new Error(response.error));
    }
    if (!response.hasOwnProperty("success") || !response.success) {
      return Promise.reject(new Error("Unknown error"));
    }
    return Promise.resolve(response);
  }

  function getLatestRelease() {
    let route = "/api/latestRelease";
    return fetch(route, {
      method: "GET",
      mode: "same-origin",
      cache: "no-cache",
      redirect: "error",
    })
      .then((httpResponse) => {
        return readHttpJsonResponse(httpResponse);
      })
      .then((jsonResponse) => {
        return checkJsonSuccess(jsonResponse);
      })
      .then((versionResponse) => {
        if (!versionResponse.hasOwnProperty("version")) {
          return Promise.reject(new Error("Missing expected version field"));
        }
        return Promise.resolve(versionResponse.version);
      })
      .catch((error) => {
        return Promise.reject(error);
      });
  }

  function getVersion() {
    let route = "/api/version";
    return fetch(route, {
      method: "GET",
      mode: "same-origin",
      cache: "no-cache",
      redirect: "error",
    })
      .then((httpResponse) => {
        return readHttpJsonResponse(httpResponse);
      })
      .then((jsonResponse) => {
        return checkJsonSuccess(jsonResponse);
      })
      .then((versionResponse) => {
        if (!versionResponse.hasOwnProperty("version")) {
          return Promise.reject(new Error("Missing expected version field"));
        }
        return Promise.resolve(versionResponse.version);
      })
      .catch((error) => {
        return Promise.reject(error);
      });
  }

  function shutdown(restart) {
    let route = "/api/shutdown";
    if (restart) {
      route = "/api/restart";
    }
    return fetch(route, {
      method: "POST",
      headers: {
        "X-CSRFToken": getCsrfToken(),
      },
      mode: "same-origin",
      cache: "no-cache",
      redirect: "error",
    })
      .then((httpResponse) => {
        // A 502 usually means that nginx shutdown before it could process the
        // response. Treat this as success.
        if (httpResponse.status === 502) {
          return Promise.resolve({
            success: true,
            error: null,
          });
        }
        return readHttpJsonResponse(httpResponse);
      })
      .then((jsonResponse) => {
        return checkJsonSuccess(jsonResponse);
      })
      .then(() => {
        // The shutdown API has no details, so return an empty dict.
        return Promise.resolve({});
      })
      .catch((error) => {
        // Depending on timing, the server may not respond to the shutdown
        // request because it's shutting down. If we get a NetworkError, assume
        // the shutdown succeeded.
        if (error.message.indexOf("NetworkError") >= 0) {
          return Promise.resolve({});
        }
        return Promise.reject(error);
      });
  }

  function update() {
    let route = "/api/update";
    return fetch(route, {
      method: "PUT",
      headers: {
        "X-CSRFToken": getCsrfToken(),
      },
      mode: "same-origin",
      cache: "no-cache",
      redirect: "error",
    })
      .then((response) => {
        return readHttpJsonResponse(response);
      })
      .then((jsonResponse) => {
        return checkJsonSuccess(jsonResponse);
      })
      .catch((error) => {
        return Promise.reject(error);
      });
  }

  function getUpdateStatus() {
    let route = "/api/update";
    return fetch(route, {
      method: "GET",
      mode: "same-origin",
      cache: "no-cache",
      redirect: "error",
    })
      .then((response) => {
        return readHttpJsonResponse(response);
      })
      .then((jsonResponse) => {
        return checkJsonSuccess(jsonResponse);
      })
      .then((updateResponse) => {
        if (!updateResponse.hasOwnProperty("status")) {
          return Promise.reject(new Error("Missing expected status field"));
        }
        return Promise.resolve(updateResponse.status);
      })
      .catch((error) => {
        return Promise.reject(error);
      });
  }

  function determineHostname() {
    const route = "/api/hostname";
    return fetch(route, {
      method: "GET",
      mode: "same-origin",
      cache: "no-cache",
      redirect: "error",
    })
      .then(processJsonResponse)
      .then((hostnameResponse) => {
        if (!hostnameResponse.hasOwnProperty("hostname")) {
          throw new ControllerError("Missing expected hostname field");
        }
        return hostnameResponse.hostname;
      });
  }

  function changeHostname(newHostname) {
    const route = "/api/hostname";
    return fetch(route, {
      method: "PUT",
      mode: "same-origin",
      cache: "no-cache",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": getCsrfToken(),
      },
      body: JSON.stringify({ hostname: newHostname }),
    })
      .then(processJsonResponse)
      .then(() => {
        return Promise.resolve(newHostname);
      });
  }

  function checkStatus(baseURL = "") {
    const route = "/api/status";
    return fetch(baseURL + route, {
      method: "GET",
      mode: "cors",
      cache: "no-cache",
      redirect: "error",
    })
      .then((response) => {
        return readHttpJsonResponse(response);
      })
      .then((jsonResponse) => {
        return checkJsonSuccess(jsonResponse);
      })
      .then(() => {
        return Promise.resolve(true);
      })
      .catch((error) => {
        return Promise.reject(error);
      });
  }

  function getDebugLogs() {
    return fetch("/api/debugLogs", {
      method: "GET",
      mode: "same-origin",
      cache: "no-cache",
      redirect: "error",
    })
      .then((response) => {
        if (!response.ok) {
          return Promise.reject(new Error(response.statusText));
        }
        return Promise.resolve(response);
      })
      .then((response) => response.text());
  }

  function textToShareableUrl(text) {
    const baseUrl = "https://logs.tinypilotkvm.com";
    return fetch(baseUrl + "/", {
      method: "PUT",
      mode: "cors",
      cache: "no-cache",
      redirect: "error",
      body: text,
    })
      .then(readHttpJsonResponse)
      .then((data) => {
        if (!data.hasOwnProperty("id")) {
          return Promise.reject(new Error("Missing expected id field"));
        }
        return Promise.resolve(data);
      })
      .then((data) => baseUrl + `/${data.id}`);
  }

  function getVideoFps() {
    return fetch("/api/settings/video/fps", {
      method: "GET",
      mode: "same-origin",
      cache: "no-cache",
      redirect: "error",
    })
      .then(readHttpJsonResponse)
      .then(checkJsonSuccess)
      .then((data) => {
        if (!data.hasOwnProperty("videoFps")) {
          return Promise.reject(new Error("Missing expected videoFps field"));
        }
        return Promise.resolve(data.videoFps);
      });
  }

  function setVideoFps(videoFps) {
    return fetch("/api/settings/video/fps", {
      method: "PUT",
      mode: "same-origin",
      cache: "no-cache",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": getCsrfToken(),
      },
      body: JSON.stringify({ videoFps }),
    })
      .then(readHttpJsonResponse)
      .then(checkJsonSuccess)
      .then(() => {});
  }

  function getVideoJpegQuality() {
    return fetch("/api/settings/video/jpeg_quality", {
      method: "GET",
      mode: "same-origin",
      cache: "no-cache",
      redirect: "error",
    })
      .then(readHttpJsonResponse)
      .then(checkJsonSuccess)
      .then((data) => {
        if (!data.hasOwnProperty("videoJpegQuality")) {
          return Promise.reject(
            new Error("Missing expected videoJpegQuality field")
          );
        }
        return Promise.resolve(data.videoJpegQuality);
      });
  }

  function setVideoJpegQuality(videoJpegQuality) {
    return fetch("/api/settings/video/jpeg_quality", {
      method: "PUT",
      mode: "same-origin",
      cache: "no-cache",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": getCsrfToken(),
      },
      body: JSON.stringify({ videoJpegQuality }),
    })
      .then(readHttpJsonResponse)
      .then(checkJsonSuccess)
      .then(() => {});
  }

  function applyVideoSettings() {
    return fetch("/api/settings/video/apply", {
      method: "POST",
      mode: "same-origin",
      cache: "no-cache",
      redirect: "error",
      headers: {
        "X-CSRFToken": getCsrfToken(),
      },
    })
      .then(readHttpJsonResponse)
      .then(checkJsonSuccess)
      .then(() => {});
  }

  if (!window.hasOwnProperty("controllers")) {
    window.controllers = {};
  }
  window.controllers.refreshCsrfToken = refreshCsrfToken;
  window.controllers.getVersion = getVersion;
  window.controllers.getLatestRelease = getLatestRelease;
  window.controllers.shutdown = shutdown;
  window.controllers.update = update;
  window.controllers.getUpdateStatus = getUpdateStatus;
  window.controllers.determineHostname = determineHostname;
  window.controllers.changeHostname = changeHostname;
  window.controllers.checkStatus = checkStatus;
  window.controllers.getDebugLogs = getDebugLogs;
  window.controllers.textToShareableUrl = textToShareableUrl;
  window.controllers.getVideoFps = getVideoFps;
  window.controllers.setVideoFps = setVideoFps;
  window.controllers.getVideoJpegQuality = getVideoJpegQuality;
  window.controllers.setVideoJpegQuality = setVideoJpegQuality;
  window.controllers.applyVideoSettings = applyVideoSettings;
})(window);
