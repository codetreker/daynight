package model

import (
	"strings"
	"testing"
)

func TestActorValidateAcceptsOnlyKnownCombinations(t *testing.T) {
	user, bot := "aaaaaaaa-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"
	valid := []Actor{UserActor(user), BotActor(user, bot), SystemActor()}
	for _, actor := range valid {
		if err := actor.Validate(); err != nil {
			t.Fatalf("%+v rejected: %v", actor, err)
		}
	}
	if got := BotActor(user, bot); got.Kind != ActorBot || got.UserID != user || got.BotID != bot {
		t.Fatalf("bot actor = %+v", got)
	}
	invalid := []Actor{
		{},
		{Kind: "worker", UserID: user},
		{Kind: ActorUser},
		{Kind: ActorUser, UserID: user, BotID: bot},
		{Kind: ActorUser, UserID: strings.ToUpper(user)},
		{Kind: ActorUser, UserID: "00000000-0000-0000-0000-000000000000"},
		{Kind: ActorUser, UserID: "{" + user + "}"},
		{Kind: ActorBot, UserID: user},
		{Kind: ActorBot, BotID: bot},
		{Kind: ActorSystem, UserID: user},
		{Kind: ActorSystem, BotID: bot},
	}
	for _, actor := range invalid {
		if err := actor.Validate(); err == nil {
			t.Fatalf("%+v accepted", actor)
		}
	}
}
