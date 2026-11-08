// Package profile owns the normalized profile capacity representation.
package profile

import (
	"bytes"
	"io"
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/measure"
)

// Profile contains exactly the identity fields accepted for storage.
type Profile struct {
	ID            string  `json:"id"`
	Email         *string `json:"email"`
	EmailVerified *bool   `json:"emailVerified"`
	Name          *string `json:"name"`
	AvatarURL     *string `json:"avatarUrl"`
}

func FromUser(u model.User) Profile {
	return Profile{ID: u.UniAuthID, Email: u.Email, EmailVerified: u.EmailVerified, Name: u.Name, AvatarURL: u.AvatarURL}
}
func Encode(w io.Writer, p Profile, max int64) (int64, error) {
	return measure.JSON(w, "profile", max, p, false)
}

// User converts the normalized identity fields to the persistence model.
func User(p Profile) model.User {
	return model.User{UniAuthID: p.ID, Email: p.Email, EmailVerified: p.EmailVerified, Name: p.Name, AvatarURL: p.AvatarURL}
}

// TeamRef and Response describe the authenticated /api/v1/me representation.
// This response uses the local user ID, unlike Profile's upstream identity ID.
type TeamRef struct {
	ID   string  `json:"id"`
	Kind string  `json:"kind"`
	Name *string `json:"name"`
}
type Response struct {
	ID            string  `json:"id"`
	Email         *string `json:"email"`
	EmailVerified *bool   `json:"emailVerified"`
	Name          *string `json:"name"`
	AvatarURL     *string `json:"avatarUrl"`
	PersonalTeam  TeamRef `json:"personalTeam"`
}

func UserResponse(u model.User) Response {
	return Response{ID: u.ID, Email: u.Email, EmailVerified: u.EmailVerified, Name: u.Name, AvatarURL: u.AvatarURL, PersonalTeam: TeamRef{ID: u.PersonalTeam.ID, Kind: u.PersonalTeam.Kind, Name: u.PersonalTeam.Name}}
}

type responseWire Response

func (v Response) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	_, err := measure.JSON(&b, "profile.response", math.MaxInt64, responseWire(v), false)
	return b.Bytes(), err
}

// EncodeResponse includes the terminal newline written by the authenticated endpoint.
func EncodeResponse(w io.Writer, u model.User, max int64) (int64, error) {
	return measure.JSON(w, "profile.response", max, responseWire(UserResponse(u)), true)
}
