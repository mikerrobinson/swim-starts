import { useState } from "react";
import { Button, Field, Segmented, Sheet, TextInput } from "./ui";
import { generateId } from "~/lib/id";
import { todayIso } from "~/types/athlete";
import { ageOn } from "~/types/athlete";
import { type Enrollment } from "~/types/team";
import type { Athlete, Gender } from "~/types/athlete";

/**
 * Add or edit one athlete. Mount it only while it's open (or key it by athlete
 * id) so the fields start from the right values.
 */
export function AthleteSheet({
  title,
  athlete,
  enrollment,
  onClose,
  onSave,
  onDelete,
  deleteLabel = "Remove from roster",
}: {
  title: string;
  athlete?: Athlete;
  /** This season's facts about them, edited alongside the person. */
  enrollment?: Pick<Enrollment, "year" | "squad">;
  onClose: () => void;
  onSave: (athlete: Athlete, facts: { year: string; squad?: string }) => void;
  onDelete?: () => void;
  deleteLabel?: string;
}) {
  const [firstName, setFirstName] = useState(athlete?.firstName ?? "");
  const [lastName, setLastName] = useState(athlete?.lastName ?? "");
  const [gender, setGender] = useState<Gender>(athlete?.gender ?? "F");
  const [year, setYear] = useState(enrollment?.year ?? "");
  const [birthDate, setBirthDate] = useState(athlete?.birthDate ?? "");
  const [squad, setSquad] = useState(enrollment?.squad ?? "");

  const canSave = Boolean(firstName.trim() || lastName.trim());
  const age = ageOn({ birthDate }, todayIso());

  const save = () => {
    if (!canSave) return;
    onSave(
      {
        id: athlete?.id ?? generateId(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        gender,
        birthDate: birthDate || undefined,
      },
      { year: year.trim(), squad: squad.trim() || undefined },
    );
  };

  return (
    <Sheet open title={title} onClose={onClose}>
      <div className="space-y-3">
        <Field label="First name">
          <TextInput
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            autoCapitalize="words"
            autoFocus={!athlete}
          />
        </Field>
        <Field label="Last name">
          <TextInput
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            autoCapitalize="words"
          />
        </Field>
        <Field label="Gender">
          <Segmented
            value={gender}
            onChange={setGender}
            options={[
              { value: "F" as Gender, label: "Girls" },
              { value: "M" as Gender, label: "Boys" },
            ]}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Year">
            <TextInput
              value={year}
              onChange={(e) => setYear(e.target.value)}
              placeholder="e.g. 10"
            />
          </Field>
          <Field label="Squad">
            <TextInput
              value={squad}
              onChange={(e) => setSquad(e.target.value)}
              placeholder="optional"
            />
          </Field>
        </div>
        <Field
          label="Birthday"
          hint={
            age === null
              ? "Optional here, but age-group entries and .sd3 exports need it."
              : `${age} years old today.`
          }
        >
          <TextInput
            type="date"
            value={birthDate}
            max={todayIso()}
            onChange={(e) => setBirthDate(e.target.value)}
          />
        </Field>
        <Button
          variant="primary"
          size="lg"
          full
          onClick={save}
          disabled={!canSave}
        >
          Save
        </Button>
        {onDelete && (
          <Button variant="ghost" full onClick={onDelete}>
            {deleteLabel}
          </Button>
        )}
      </div>
    </Sheet>
  );
}
