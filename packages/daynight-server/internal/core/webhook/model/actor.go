package model

import (
	"fmt"

	"github.com/google/uuid"
)

// ActorKind identifies who caused a captured event. The empty kind means the
// actor is unknown, which is the stored state of events captured before
// actors were recorded.
type ActorKind string

const (
	ActorUnknown ActorKind = ""
	ActorUser    ActorKind = "user"
	ActorBot     ActorKind = "bot"
	ActorSystem  ActorKind = "system"
)

// Actor is stored with a captured event and never rendered into the outbound
// wire format.
type Actor struct {
	Kind          ActorKind
	UserID, BotID string
}

// UserActor records a credentialed write without a verified Bot identity.
func UserActor(userID string) Actor { return Actor{Kind: ActorUser, UserID: userID} }

// BotActor records a credentialed write whose Bot ID the source transaction
// verified as owned by userID and not deleted.
func BotActor(userID, botID string) Actor {
	return Actor{Kind: ActorBot, UserID: userID, BotID: botID}
}

// SystemActor records a server-internal write with no user credential.
func SystemActor() Actor { return Actor{Kind: ActorSystem} }

// Validate accepts only the field combination of a known actor kind.
func (a Actor) Validate() error {
	switch a.Kind {
	case ActorUser:
		if canonicalActorID(a.UserID) && a.BotID == "" {
			return nil
		}
	case ActorBot:
		if canonicalActorID(a.UserID) && canonicalActorID(a.BotID) {
			return nil
		}
	case ActorSystem:
		if a.UserID == "" && a.BotID == "" {
			return nil
		}
	}
	return fmt.Errorf("invalid webhook event actor")
}

func canonicalActorID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id != uuid.Nil && id.String() == value
}
