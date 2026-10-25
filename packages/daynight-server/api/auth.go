package api

import "time"

type User struct {
	ID            string  `json:"id"`
	Email         *string `json:"email"`
	EmailVerified *bool   `json:"emailVerified"`
	Name          *string `json:"name"`
	AvatarURL     *string `json:"avatarUrl"`
}

type PersonalAccessToken struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	CreatedAt time.Time  `json:"createdAt"`
	ExpiresAt *time.Time `json:"expiresAt"`
}

type PersonalAccessTokenList struct {
	Items []PersonalAccessToken `json:"items"`
}

type CreatedPersonalAccessToken struct {
	PersonalAccessToken
	Token string `json:"token"`
}

type CreatePersonalAccessTokenRequest struct {
	Name      string     `json:"name"`
	ExpiresAt *time.Time `json:"expiresAt"`
}

type UpdatePersonalAccessTokenRequest struct {
	ExpiresAt         *time.Time `json:"expiresAt"`
	ExpectedExpiresAt *time.Time `json:"expectedExpiresAt"`
	ExpectedUserID    string     `json:"expectedUserId"`
}
