import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

/**
 * The Cognito side of user management (users-routes.ts). A user exists in two
 * places: the Cognito account (credentials) and the snowball-users row (role,
 * client, active). The admin panel keeps both in step through this interface;
 * tests inject a fake.
 */
export interface UserDirectory {
  /** Creates the account with a permanent password (no forced change at first login). */
  create(email: string, password: string): Promise<void>;
  setEnabled(email: string, enabled: boolean): Promise<void>;
  remove(email: string): Promise<void>;
}

export type DirectoryErrorKind = 'exists' | 'invalid-password';

export class DirectoryError extends Error {
  constructor(public kind: DirectoryErrorKind, message: string) {
    super(message);
  }
}

export function createCognitoDirectory(userPoolId: string, client = new CognitoIdentityProviderClient({})): UserDirectory {
  return {
    async create(email, password) {
      try {
        await client.send(
          new AdminCreateUserCommand({
            UserPoolId: userPoolId,
            Username: email,
            MessageAction: 'SUPPRESS',
            UserAttributes: [
              { Name: 'email', Value: email },
              { Name: 'email_verified', Value: 'true' },
            ],
          }),
        );
      } catch (err) {
        if ((err as { name?: string }).name === 'UsernameExistsException') {
          throw new DirectoryError('exists', 'email already registered');
        }
        throw err;
      }
      try {
        await client.send(
          new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: email, Password: password, Permanent: true }),
        );
      } catch (err) {
        // Do not leave a half-created account behind.
        await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email })).catch(() => undefined);
        if ((err as { name?: string }).name === 'InvalidPasswordException') {
          throw new DirectoryError('invalid-password', (err as Error).message);
        }
        throw err;
      }
    },
    async setEnabled(email, enabled) {
      const input = { UserPoolId: userPoolId, Username: email };
      await client.send(enabled ? new AdminEnableUserCommand(input) : new AdminDisableUserCommand(input));
    },
    async remove(email) {
      await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }));
    },
  };
}
