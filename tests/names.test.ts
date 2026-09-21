import { done, eq } from "./harness.ts";
import { splitTypedName } from "../app/lib/names.ts";

// What somebody types unprompted.
eq(splitTypedName("Mike Robinson"), { firstName: "Mike", lastName: "Robinson" }, "first last");
// What they copy off a heat sheet, or off this app's own surname-sorted
// roster column. Without the comma rule this lands as first name "Robinson,"
// — punctuation and all, in the wrong field, in front of the desk.
eq(splitTypedName("Robinson, Mike"), { firstName: "Mike", lastName: "Robinson" }, "last, first");
eq(splitTypedName("Castellanos,Sofia"), { firstName: "Sofia", lastName: "Castellanos" }, "no space after the comma");
eq(splitTypedName("  Ada   Lovelace  "), { firstName: "Ada", lastName: "Lovelace" }, "stray spaces collapse");
eq(splitTypedName("Prince"), { firstName: "Prince", lastName: "" }, "one name is a first name");
eq(splitTypedName("Mary Anne Evans"), { firstName: "Mary Anne", lastName: "Evans" }, "the surname is the last word");
eq(splitTypedName(""), { firstName: "", lastName: "" }, "nothing splits into nothing");

done();
