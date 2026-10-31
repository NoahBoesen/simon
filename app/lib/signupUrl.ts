export function signupUrl(
  requestOrigin: string,
  options: { hostedOnVercel?: boolean; localPublicUrl?: string },
) {
  const origin = options.hostedOnVercel
    ? requestOrigin
    : options.localPublicUrl || requestOrigin;
  return new URL("/join", origin).toString();
}
