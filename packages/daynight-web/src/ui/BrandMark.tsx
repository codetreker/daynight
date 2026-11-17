type BrandMarkProps = { readonly className: string; readonly surface: "light" | "dark" };

export const BrandMark = ({ className, surface }: BrandMarkProps) => <svg className={className} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <rect x="7" y="6" width="12" height="52" rx="3" fill={surface === "dark" ? "#b3a9ff" : "color-mix(in srgb, #7567e8 76%, #fff)"} />
  <path d="M25 6H29C46 6 59 17 59 32S46 58 29 58H25V46H29C39 46 47 40 47 32S39 18 29 18H25Z" fill="#7567e8" />
</svg>;
