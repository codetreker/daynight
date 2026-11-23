package api

type BotDeletionRecoveryPage struct {
	Items      []BotDeletionRecovery `json:"items"`
	NextCursor *string               `json:"nextCursor"`
}
