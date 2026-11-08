package profile

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

func TestProfileEncodingAndBudget(t *testing.T) {
	avatar := strings.Repeat("<", (1<<20)/6)
	p := Profile{ID: "id", AvatarURL: &avatar}
	_, err := Encode(io.Discard, p, 1<<20)
	var v *limit.Violation
	if !errors.As(err, &v) {
		t.Fatalf("escape expansion must exceed budget: %v", err)
	}
	avatar = "<&世界"
	want, _ := json.Marshal(p)
	var b bytes.Buffer
	n, err := Encode(&b, p, int64(len(want)))
	if err != nil || n != int64(len(want)) || !bytes.Equal(want, b.Bytes()) {
		t.Fatalf("got %s want %s err=%v", b.Bytes(), want, err)
	}
	_, err = Encode(io.Discard, p, int64(len(want)-1))
	if !errors.As(err, &v) {
		t.Fatalf("over budget: %v", err)
	}
}

func TestUserProjection(t *testing.T) {
	name := "名字"
	email := "a@x"
	verified := true
	avatar := "data:pic"
	in := model.User{ID: "local", UniAuthID: "remote", Name: &name, Email: &email, EmailVerified: &verified, AvatarURL: &avatar}
	p := FromUser(in)
	got := User(p)
	if got.UniAuthID != in.UniAuthID || got.Name != in.Name || got.Email != in.Email || got.EmailVerified != in.EmailVerified || got.AvatarURL != in.AvatarURL || got.ID != "" {
		t.Fatalf("profile projection %#v", got)
	}
}

func TestResponseMatchesProductionJSON(t *testing.T) {
	name := "名字<&"
	email := "x@example.com"
	avatar := "data:pic"
	team := "Personal<&"
	u := model.User{ID: "local-id", UniAuthID: "upstream-id", Name: &name, Email: &email, AvatarURL: &avatar, PersonalTeam: model.TeamRef{ID: "team", Kind: "personal", Name: &team}}
	value := UserResponse(u)
	got, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	want, err := json.Marshal(responseWire(value))
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("response mismatch got %s want %s err %v", got, want, err)
	}
	var buf bytes.Buffer
	n, err := EncodeResponse(&buf, u, int64(len(want)+1))
	if err != nil || n != int64(len(want)+1) || !bytes.Equal(buf.Bytes(), append(want, '\n')) {
		t.Fatalf("response encoding %q %v", buf.Bytes(), err)
	}
	if bytes.Contains(buf.Bytes(), []byte("upstream-id")) {
		t.Fatal("upstream identity leaked into response")
	}
	_, err = EncodeResponse(io.Discard, u, n-1)
	var v *limit.Violation
	if !errors.As(err, &v) || !v.LowerBound {
		t.Fatalf("response budget %v", err)
	}
}
