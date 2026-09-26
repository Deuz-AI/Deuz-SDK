function handler(event) {
  var request = event.request;
  var headers = request.headers;

  // proxy.ts serves markdown for the SAME url when Accept mentions text/markdown.
  // CloudFront ignores Vary, so collapse Accept to two values and put it in the
  // cache key - otherwise a bot's markdown request poisons the cache for browsers.
  var accept = headers.accept && headers.accept.value ? headers.accept.value.toLowerCase() : '';
  headers.accept = { value: accept.indexOf('text/markdown') !== -1 ? 'text/markdown' : 'text/html' };

  // RSC is the only router header that changes the body (all pages are prerendered).
  // Pin it to one value so the key has at most two states.
  if (headers.rsc) {
    headers.rsc = { value: '1' };
  }

  return request;
}
