/** The app's version, from package.json at build time, as "v1.9.0". Empty when unknown. */
export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ? `v${process.env.NEXT_PUBLIC_APP_VERSION}` : "";
