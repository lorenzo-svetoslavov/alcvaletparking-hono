import { SupabaseClient } from "@supabase/supabase-js";

type TariffTier = { threshold: number; price: number };

/**
 * Calcula el precio de aparcamiento leyendo las tarifas dinámicamente desde Supabase.
 * De esta forma el administrador puede actualizar precios sin necesidad de redesplegar.
 */
export async function calculateParkingPrice(
    fechaEntrada: string | undefined | null,
    fechaSalida: string | undefined | null,
    tipoPlaza: string | undefined | null,
    supabase: SupabaseClient
): Promise<{ totalPrice: number; suplemento: number }> {

    // Si falta algún dato, devolvemos 0 inmediatamente
    if (!fechaEntrada || !fechaSalida || !tipoPlaza) {
        return { totalPrice: 0, suplemento: 0 };
    }

    // Crear fechas (al no tener hora, JS asume UTC 00:00:00)
    const start = new Date(fechaEntrada);
    const end = new Date(fechaSalida);

    // Calcular diferencia en milisegundos
    const diffMs = end.getTime() - start.getTime();

    // Convertir a días (1000ms * 60s * 60m * 24h = 86400000 ms/día)
    let days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    // Regla de negocio: Si entra y sale el mismo día (diferencia 0), cobramos 1 día
    if (days === 0) days = 1;

    // Leemos las tarifas desde Supabase ordenadas de MAYOR A MENOR threshold
    const { data: tariffTable, error } = await supabase
        .from('tarifas')
        .select('threshold, price')
        .eq('tipo_plaza', tipoPlaza)
        .order('threshold', { ascending: false });

    if (error) {
        throw new Error(`Error al leer tarifas: ${error.message}`);
    }

    if (!tariffTable || tariffTable.length === 0) {
        throw new Error(`Tipo de plaza desconocido: ${tipoPlaza}`);
    }

    // Buscamos el rango aplicable (lógica "floor": primer threshold <= days)
    const match = (tariffTable as TariffTier[]).find((tier) => days >= tier.threshold);

    // Si no encuentra rango, usamos el precio del último registro (el más bajo)
    let totalPrice = match ? match.price : tariffTable[tariffTable.length - 1].price;

    // Suplemento fin de semana: viernes -> domingo
    let suplemento = 0;
    const dayEntrada = start.getUTCDay();
    const daySalida = end.getUTCDay();

    if (dayEntrada === 5 && daySalida === 0) {
        const { data: config } = await supabase
            .from('configuracion')
            .select('valor')
            .eq('clave', 'suplemento_finde')
            .single();

        if (config && config.valor > 0) {
            suplemento = config.valor;
            totalPrice += suplemento;
        }
    }

    return { totalPrice, suplemento };
}