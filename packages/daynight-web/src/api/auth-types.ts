export type AuthProvider = "microsoft" | "google" | "github";
export type LoginProvider = AuthProvider;
export type AuthConfig = { readonly providers: readonly AuthProvider[] };

export type User = {
  readonly id: string;
  readonly email: string | null;
  readonly emailVerified: boolean | null;
  readonly name: string | null;
  readonly avatarUrl: string | null;
};
export type CurrentUser = User;

export type PersonalAccessToken = {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
};
export type PersonalAccessTokenExpiryUpdate = {
  readonly expiresAt: string | null;
  readonly expectedExpiresAt: string | null;
  readonly expectedUserId: string;
};
export type CreatedPersonalAccessToken = PersonalAccessToken & { readonly token: string };
export type ProjectRole = "admin" | "member";
export type ProjectMember = {
  readonly projectId: string;
  readonly userId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly avatarUrl: string | null;
  readonly role: ProjectRole;
  readonly version: bigint;
  readonly createdAt: string;
  readonly updatedAt: string;
};
export type ProjectInvitation = {
  readonly id: string;
  readonly projectId: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedBy: string | null;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
};
export type CreatedProjectInvitation = ProjectInvitation & { readonly link: string };
export type ProjectInvitationInspection = {
  readonly projectId: string;
  readonly projectName: string;
  readonly member?: ProjectMember;
};
export type InvitationInspection = ProjectInvitationInspection;

export type DeviceAuthorizationStatus = "pending" | "approved" | "denied" | "expired" | "consumed";
export type DeviceAuthorizationInspection = {
  readonly userCode: string;
  readonly expiresAt: string;
  readonly status: DeviceAuthorizationStatus;
};
