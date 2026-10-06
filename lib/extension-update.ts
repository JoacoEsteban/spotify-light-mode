import parse from "semver/functions/parse";
import { match } from "ts-pattern";
import { binding } from "ts-pattern-binding";

export class ExtensionUpdate {
  static tabAction({
    previousVersion,
    currentVersion,
  }: {
    previousVersion: string | undefined;
    currentVersion: string;
  }): "reinject" | "reload" {
    const { bind: major, ref: sameMajor } = binding<number>();
    const { bind: minor, ref: sameMinor } = binding<number>();

    return match([parse(previousVersion), parse(currentVersion)])
      .with(
        [
          { major, minor },
          { major: sameMajor, minor: sameMinor },
        ],
        () => "reinject" as const,
      )
      .otherwise(() => "reload" as const);
  }
}
