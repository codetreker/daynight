package tag

import (
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestNameFilterDigestVectors(t *testing.T) {
	tests := []struct {
		name, match, digest string
		names               []string
	}{
		{"any-basic", "any", "d6b8862fae28deb5524520e92b0c2252f54a3d6607ea333c47c6ba91b99816f2", []string{"backend", "urgent"}},
		{"any-case-reorder-dedupe", "any", "d6b8862fae28deb5524520e92b0c2252f54a3d6607ea333c47c6ba91b99816f2", []string{"URGENT", "Backend", "backend", " urgent "}},
		{"all-basic", "all", "b60f83f3c95a35685b5ceedbcd54b0aea405fef15c3f8bb11203002f0eca3ab6", []string{"backend", "urgent"}},
		{"all-case-reorder", "all", "b60f83f3c95a35685b5ceedbcd54b0aea405fef15c3f8bb11203002f0eca3ab6", []string{"URGENT", "Backend"}},
		{"empty-any", "any", "f394e6e6411d7ce2e190d62c0ec2bf0b03248a80ccbc81665757f672f28da1b4", []string{}},
		{"empty-all", "all", "f394e6e6411d7ce2e190d62c0ec2bf0b03248a80ccbc81665757f672f28da1b4", []string{}},
		{"html", "any", "7d57ff477191df9dee039686b3fd0b5b08760c8c59a038d2c61f951f4ac8e7d0", []string{"<>&", "html"}},
		{"quotes-backslash", "all", "8bd5284adbc84a702f90b9083eaa6052b1c94077529dd16d621259803f0f854b", []string{"a\"b", `a\b`}},
		{"chinese", "any", "66b4554122a75ae7c8bf7ff9906ce07d841c4a2392a1d07b041cd6de84e3f0ed", []string{"后端", "紧急"}},
		{"scalar-order", "all", "66f47f2cf0f7735832daa25f2ab12ed6dd6e16e20ac5ab52dbc552fd6b36f56c", []string{"𐀀", "", "😀", "a"}},
		{"non-ascii-upper", "any", "b3b98251fee79ee896b3ed60eb8745f31796009ca8e31f2356a26f36186bad59", []string{"É"}},
		{"non-ascii-lower", "any", "f4c47b9a36cdc0d6ca7fff7292dabdbe2a7e76de600bf080fa109e7e89954f02", []string{"é"}},
		{"decomposed", "any", "307fbb6c5220ab4ca91a4a9e5d3de6733d175d7934cb72b2133631370c6e5c13", []string{"é"}},
		{"unicode-whitespace", "any", "41957b95de93facb7581788d9da48b8c5e5250bd0c49d7c0842df4f8d69e0088", []string{" Ab C ", "backend"}},
		{"internal-whitespace", "any", "bf81f6373a3af7677668b2ca53e5b437878c9170b90091e4437bf1f9c2ab4b1c", []string{"ab  c", "ab c"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := NameFilterDigest(model.TagNameFilter{Names: tt.names, Match: tt.match})
			if err != nil || got != tt.digest {
				t.Fatalf("digest = %q, %v; want %q", got, err, tt.digest)
			}
		})
	}
}

func TestNormalizeNameFilter(t *testing.T) {
	input := model.TagNameFilter{Names: []string{" urgent ", "Backend", "backend", "URGENT", "𐀀", ""}, Match: "all"}
	got, err := NormalizeNameFilter(input)
	want := model.TagNameFilter{Names: []string{"Backend", "urgent", "", "𐀀"}, Match: "all"}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("normalize = %#v, %v; want %#v", got, err, want)
	}
	keys, err := NameFilterKeys(input)
	if err != nil || !reflect.DeepEqual(keys, []string{"backend", "urgent", "", "𐀀"}) {
		t.Fatalf("keys = %#v, %v", keys, err)
	}
	got, err = NormalizeNameFilter(model.TagNameFilter{Names: []string{}, Match: "all"})
	if err != nil || got.Match != "any" || got.Names == nil || len(got.Names) != 0 {
		t.Fatalf("empty = %#v, %v", got, err)
	}
	if _, err := NormalizeNameFilter(model.TagNameFilter{Names: []string{strings.Repeat("😀", 64)}, Match: "any"}); err != nil {
		t.Fatalf("64 scalars: %v", err)
	}
}

func TestNameFilterInvalid(t *testing.T) {
	tests := []model.TagNameFilter{
		{Names: nil, Match: "any"}, {Names: []string{}, Match: ""}, {Names: []string{}, Match: "ANY"},
		{Names: []string{"  "}, Match: "any"}, {Names: []string{"ok", "\xff"}, Match: "any"},
		{Names: []string{strings.Repeat("😀", 65)}, Match: "any"},
		{Names: []string{"a\x00b"}, Match: "any"}, {Names: []string{"a\u2028b"}, Match: "any"},
		{Names: []string{"a\u2029b"}, Match: "any"},
	}
	for _, filter := range tests {
		if _, err := NormalizeNameFilter(filter); err == nil {
			t.Errorf("accepted invalid filter %#v", filter)
		}
		if _, err := NameFilterKeys(filter); err == nil {
			t.Errorf("keys accepted invalid filter %#v", filter)
		}
		if _, err := NameFilterDigest(filter); err == nil {
			t.Errorf("digest accepted invalid filter %#v", filter)
		}
		if _, err := MatchNameFilter(filter, nil); err == nil {
			t.Errorf("match accepted invalid filter %#v", filter)
		}
	}
}

func TestMatchNameFilter(t *testing.T) {
	tests := []struct {
		match       string
		names, task []string
		want        bool
	}{
		{"all", []string{}, nil, true},
		{"any", []string{"backend", "urgent"}, nil, false},
		{"any", []string{"backend", "urgent"}, []string{"BACKEND"}, true},
		{"all", []string{"backend", "urgent"}, []string{"BACKEND"}, false},
		{"all", []string{"backend", "urgent"}, []string{"Backend", "urgent", "bug"}, true},
		{"any", []string{"backend", "urgent"}, []string{"frontend"}, false},
		{"all", []string{"É", "é"}, []string{"É"}, false},
		{"any", []string{"é"}, []string{"é"}, false},
	}
	for _, tt := range tests {
		got, err := MatchNameFilter(model.TagNameFilter{Names: tt.names, Match: tt.match}, tt.task)
		if err != nil || got != tt.want {
			t.Errorf("match %#v against %#v = %v, %v; want %v", tt.names, tt.task, got, err, tt.want)
		}
	}
	if _, err := MatchNameFilter(model.TagNameFilter{Names: []string{}, Match: "any"}, []string{"bad\x00name"}); err == nil {
		t.Fatal("accepted invalid task name")
	}
}
