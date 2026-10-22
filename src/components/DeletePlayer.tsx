import { useEffect, useState } from "react";

/** Удаление игрока в два нажатия: «✕» → «Удалить?» (3 секунды на подтверждение). */
export default function DeletePlayer({ name, onDelete }: { name: string; onDelete: () => void }) {
    const [armed, setArmed] = useState(false);
    useEffect(() => {
        if (!armed) return;
        const t = setTimeout(() => setArmed(false), 3000);
        return () => clearTimeout(t);
    }, [armed]);
    return (
        <button
            className={"del-player" + (armed ? " armed" : "")}
            title={armed ? `Нажми ещё раз — «${name}» и его прогресс будут удалены` : "Удалить игрока"}
            onClick={() => (armed ? onDelete() : setArmed(true))}
        >
            {armed ? "Удалить?" : "✕"}
        </button>
    );
}
