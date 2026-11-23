package api

import "time"

type OAuthAPITokens struct {
	AccessToken     string    `json:"access_token"`
	TokenType       string    `json:"token_type"`
	ExpiresIn       int64     `json:"expires_in"`
	AccessExpiresAt time.Time `json:"access_expires_at"`
	RefreshToken    string    `json:"refresh_token"`
	GrantExpiresAt  time.Time `json:"grant_expires_at"`
	Scope           string    `json:"scope"`
	Resource        string    `json:"resource"`
	ClientID        string    `json:"client_id"`
	GrantID         string    `json:"grant_id"`
	UserID          string    `json:"user_id"`
}
