ALTER TABLE "app_private"."hands" ADD CONSTRAINT "hands_participant_seats_unique_check" CHECK (cardinality("app_private"."hands"."participant_seats") = (
        ("app_private"."hands"."participant_seats" @> ARRAY[0]::integer[])::integer
        + ("app_private"."hands"."participant_seats" @> ARRAY[1]::integer[])::integer
        + ("app_private"."hands"."participant_seats" @> ARRAY[2]::integer[])::integer
        + ("app_private"."hands"."participant_seats" @> ARRAY[3]::integer[])::integer
        + ("app_private"."hands"."participant_seats" @> ARRAY[4]::integer[])::integer
        + ("app_private"."hands"."participant_seats" @> ARRAY[5]::integer[])::integer
        + ("app_private"."hands"."participant_seats" @> ARRAY[6]::integer[])::integer
        + ("app_private"."hands"."participant_seats" @> ARRAY[7]::integer[])::integer
        + ("app_private"."hands"."participant_seats" @> ARRAY[8]::integer[])::integer
      ));