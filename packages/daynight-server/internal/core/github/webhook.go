package github

// WebhookEvent is the verified, minimally decoded identity of a GitHub event.
// Its body is never used as a PR observation or proof of current access.
type WebhookEvent struct {
	Kind                                 string
	DeliveryID                           string
	InstallationID, RepositoryID, Number int64
}
