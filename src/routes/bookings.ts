import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { createBookingSchema } from '../schemas/booking';
import { Bindings } from '../types';
import { calculatePriceSchema } from '../schemas/pricing';
import { calculateParkingPrice } from '../utils/pricing';
import { generateBookingPDF } from '../utils/emailService';
import { Buffer } from 'node:buffer';
import { getBookingEmailHtml } from '../utils/emailTemplate';
import { getBookingUpdateEmailHtml } from '../utils/emailUpdateTemplate';
import { getBookingCancellationEmailHtml } from '../utils/emailCancellationTemplate';

const bookings = new Hono<{ Bindings: Bindings }>();

// POST /bookings
bookings.post('/', async (c) => {
    try {
        // Obtenemos el JSON "crudo" (tipo any/unknown)
        const body = await c.req.json();

        // Validamos manualmente usando .safeParse()
        // Esto no lanza error, sino que devuelve un objeto con resultado
        const result = createBookingSchema.safeParse(body);

        // Comprobamos si falló
        if (!result.success) {
            console.log('Errores de validación: ', result.error.issues);
            // Recorremos los errores y creamos un array limpio
            const formattedErrors = result.error.issues.map((issue) => {
                return {
                    campo: issue.path[0], // El nombre del campo (ej: "dateIn")
                    mensaje: issue.message // El mensaje de error
                };
            });

            return c.json({
                success: false,
                message: 'Datos de reserva inválidos',
                errors: formattedErrors
            }, 400);
        };

        // Si todo va bien, usamos los datos LIMPIOS y TIPADOS
        const data = result.data;
        // Iniciar Supabase (Usando las variables de entorno de Hono)
        const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_KEY);

        // Datos del cliente
        let clienteData = {};

        // USUARIO ESTA REGISTRADO (Buscamos en BD su información)
        if (data.clienteId) {
            const { data: perfil, error } = await supabase
                .from('clientes')
                .select(`
                    nombre,
                    telefono,
                    direccion,
                    cif,
                    nos_conociste,
                    usuarios (email)
                    `)
                .eq('id', data.clienteId)
                .single();

            if (error || !perfil) {
                return c.json({
                    success: false,
                    message: `No se ha encontrado el usuario con id ${data.clienteId}`
                }, 500);
            }

            clienteData = {
                nombre_completo: perfil.nombre,
                email: (perfil.usuarios as any)?.email,
                telefono: perfil.telefono,
                direccion: perfil.direccion,
                cif: perfil.cif,
                nos_conociste: perfil.nos_conociste
            }
        } else {
            clienteData = {
                nombre_completo: data.nombreCompleto,
                email: data.email,
                telefono: data.telefono,
                nos_conociste: data.nosConociste || null,
                cif: data.cif || null,
                direccion: data.direccion || null,
                nombre_conductor: data.nombreConductor || null
            }
        };

        // Re-calcumos el precio por seguridad (Para que desde el frontend no nos envien cualquier precio)
        // const { totalPrice } = calculateParkingPrice(data.fechaEntrada, data.fechaSalida, data.tipoPlaza);

        // Es buena práctica convertir camelCase a snake_case para SQL
        const reservaPayload = {
            fecha_entrada: data.fechaEntrada || null,
            hora_entrada: data.horaEntrada || null,
            fecha_salida: data.fechaSalida || null,
            hora_salida: data.horaSalida || null,
            tipo_plaza: data.tipoPlaza,
            coche: data.coche,
            matricula: data.matricula.toUpperCase(),
            num_vuelo: data.numVuelo?.toUpperCase() || null,
            comentarios: data.comentarios || null,

            cliente_id: data.clienteId || null, // Importante: Este ID debe existir en auth.users o tu tabla de users
            // precio: totalPrice,
            precio: data.precio, // Por ahora dejamos que venga del frontend
            suplemento: data.suplemento || 0,

            ...clienteData
        };

        // Insertar en Supabase
        const { data: newBooking, error } = await supabase
            .from('reservas')
            .insert(reservaPayload)
            .select()
            .single();

        // 5. Manejar error de base de datos
        if (error) {
            return c.json({
                success: false,
                message: 'Error al guardar en la base de datos',
                details: error.message
            }, 500);
        }

        try {
            // Generar el PDF (Binario)
            const pdfUint8Array = generateBookingPDF(newBooking);
            const pdfBuffer = Buffer.from(pdfUint8Array);
            
            // GENERAR HTML (Plantilla Visual)
            const htmlContent = getBookingEmailHtml(newBooking);

            // Nos conectamos a Resend a través de la API KEY
            const resend = new Resend(c.env.RESEND_API_KEY);

            await resend.emails.send({
                from: 'ALC Valet Parking <reservas@alcvaletparking.com>',
                to: newBooking.email,
                bcc: 'info@alcvaletparking.com',
                subject: `Reserva Confirmada #${newBooking.num_reserva}`,
                html: htmlContent,
                attachments: [
                    {
                        filename: `Ticket_${newBooking.num_reserva}.pdf`,
                        content: pdfBuffer
                    },
                ]
            });
        } catch (err) {
            console.error("Error generando/enviando PDF:", err);
        }

        return c.json({
            success: true,
            message: 'Reserva creada correctamente',
            data: newBooking
        }, 201);
    } catch (e) {
        return c.json({
            success: false,
            message: 'Error interno del servidor',
            error_real: e instanceof Error ? e.message : String(e)
        }, 500);
    }
});

// PUT /bookings/:id -> ACTUALIZAR Y NOTIFICAR
bookings.put('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json();
    const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_KEY);
    const resend = new Resend(c.env.RESEND_API_KEY);

    // 2. Actualizar en Supabase
    const { data: updatedBooking, error } = await supabase
        .from('reservas')
        .update({
            ...body,
            updated_at: new Date().toISOString()
        })
        .eq('id', id)
        .select()
        .single();

    if (error) return c.json({ success: false, message: error.message }, 500);

    // Generar PDF Nuevo y Enviar Email
    try {
        const pdfUint8Array = generateBookingPDF(updatedBooking);
        const pdfBuffer = Buffer.from(pdfUint8Array);
        
        // Asumiendo que tienes una función getBookingEmailHtml, o usa un string simple
        const htmlContent = getBookingUpdateEmailHtml(updatedBooking);

        await resend.emails.send({
            from: 'ALC Valet Parking <reservas@alcvaletparking.com>',
            to: updatedBooking.email,
            bcc: 'info@alcvaletparking.com',
            subject: `Modificación Reserva #${updatedBooking.num_reserva}`,
            html: htmlContent,
            attachments: [{ filename: `Ticket_MOD_${updatedBooking.num_reserva}.pdf`, content: pdfBuffer }]
        });
    } catch (err) {
        console.error("Error enviando email update:", err);
    }

    return c.json({ success: true, data: updatedBooking });
});

// DELETE /bookings/:id -> ELIMINAR Y NOTIFICAR
bookings.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_KEY);
    const resend = new Resend(c.env.RESEND_API_KEY);

    // 1. Obtener datos antes de borrar (para tener el email)
    const { data: bookingToDelete } = await supabase
        .from('reservas')
        .select('*')
        .eq('id', id)
        .single();

    if (!bookingToDelete) return c.json({ success: false, message: 'Reserva no encontrada' }, 404);

    // 2. Borrar de Supabase
    const { error } = await supabase.from('reservas').delete().eq('id', id);

    if (error) return c.json({ success: false, message: error.message }, 500);

    // 3. Enviar Email de Cancelación
    try {
        const htmlContent = getBookingCancellationEmailHtml(bookingToDelete);
        await resend.emails.send({
            from: 'ALC Valet Parking <reservas@alcvaletparking.com>',
            to: bookingToDelete.email,
            bcc: 'info@alcvaletparking.com',
            subject: `Cancelación Reserva #${bookingToDelete.num_reserva}`,
            html: htmlContent
        });
    } catch (err) {
        console.error("Error enviando email delete:", err);
    }

    return c.json({ success: true });
});

// POST /bookings/pricing
// Calculamos el precio de la reserva usando tarifas dinámicas de Supabase
bookings.post('/pricing', async (c) => {
    const body = await c.req.json();

    // Validamos los campos de fecha, hora y tipo de plaza
    const result = calculatePriceSchema.safeParse(body);

    if (!result.success) {
        return c.json({ success: false, errors: result.error.issues }, 400);
    }

    const { fechaEntrada, fechaSalida, tipoPlaza } = result.data;

    try {
        const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_KEY);

        // Leemos tarifas dinámicamente desde BD
        const calculation = await calculateParkingPrice(fechaEntrada, fechaSalida, tipoPlaza, supabase);

        // Devolvemos el cálculo al frontend
        return c.json({
            success: true,
            data: calculation
            // Devolverá: { totalPrice: 30 }
        });
    } catch (e) {
        return c.json({
            success: false,
            message: e instanceof Error ? e.message : "Error al calcular"
        }, 400);
    }
});

export default bookings;