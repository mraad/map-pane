// Wait for the server's first complete stdout line, retaining startup diagnostics.
export function serverUrl(child, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let output = "", stderr = "";
    const finish = (error, url) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(new Error(`${error.message}${stderr ? `: ${stderr.trim()}` : ""}`));
      else resolve(url);
    };
    const onData = (chunk) => {
      output += chunk;
      const end = output.indexOf("\n");
      if (end < 0) return;
      // The bridge's first line is `bridge: <url>`.
      const url = output.slice(0, end).trim().replace(/^bridge: /, "");
      if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url)) return finish(new Error("Server printed an invalid URL"));
      finish(null, url);
    };
    const onStderr = (chunk) => { stderr += chunk; };
    const onError = (error) => finish(error);
    // close follows stderr draining, so early-exit errors include the diagnostic.
    const onClose = (code, signal) => finish(new Error(`Server exited before its URL (${signal ?? code})`));
    const timer = setTimeout(() => finish(new Error("Server URL timed out")), timeout);
    child.stdout.on("data", onData);
    child.stderr.on("data", onStderr);
    child.on("error", onError);
    child.on("close", onClose);
  });
}
