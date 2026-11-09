package tasksearch

import "testing"

func TestFieldValidityAndParticipation(t *testing.T) {
	fields := []struct {
		field                  Field
		valid                  bool
		id, title, description bool
	}{
		{AnyField, true, true, true, true},
		{IDField, true, true, false, false},
		{TitleField, true, false, true, false},
		{DescriptionField, true, false, false, true},
		{Field(255), false, false, false, false},
	}
	for _, tc := range fields {
		if got := tc.field.Valid(); got != tc.valid {
			t.Errorf("field %d Valid()=%v, want %v", tc.field, got, tc.valid)
		}
		for _, target := range []struct {
			field Field
			want  bool
		}{
			{IDField, tc.id}, {TitleField, tc.title}, {DescriptionField, tc.description},
			{AnyField, false}, {Field(255), false},
		} {
			if got := tc.field.Includes(target.field); got != target.want {
				t.Errorf("field %d Includes(%d)=%v, want %v", tc.field, target.field, got, target.want)
			}
		}
	}
}
