/**
 * The signed-in account, as the SERVER knows it.
 *
 * Read from `GET /me`, keyed on the token's subject, so the name in the header
 * is the account's name in the database at this moment -- not something typed
 * at sign-in and not a copy cached from last week. Until it arrives the header
 * shows the role alone rather than a placeholder name.
 */
export interface Profile {
  readonly platformUserId: string;
  readonly fullName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly roleKey: string;
  readonly roleName: string;
  readonly status: string;
  readonly lastLoginAt: string | null;
}
