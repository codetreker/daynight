package model

// InvitationUnavailable returns the shared refusal for an unusable invitation.
func InvitationUnavailable(cause error) error {
	return &Fault{Code: "invitation_unavailable", Message: "Invitation is unavailable.", Cause: cause}
}
