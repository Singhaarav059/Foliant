import "server-only";

// An error whose message is written for the person using the site. Anything
// else is logged on the server and answered with a generic message.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
